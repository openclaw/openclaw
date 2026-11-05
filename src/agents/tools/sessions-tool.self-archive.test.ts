import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import * as inProcessGateway from "./in-process-gateway.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsTool } from "./sessions-tool.js";
import { withSessionToolTestCaller } from "./sessions-tool.test-helpers.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sessions-tool-self-archive-");
const authority = (profileId: string, scopes = ["operator.write"], signal?: AbortSignal) =>
  createAdmittedRunOperatorAuthority({ profileId, scopes, signal, assertCurrent: () => {} });
const patchRequest = (key: string, params: Record<string, unknown>) => ({
  method: "sessions.patch",
  params: { key, ...params },
});
const archive = (tool: ReturnType<typeof createSessionsTool>, id: string, settings = {}) =>
  tool.execute(id, { action: "patch", archived: true, ...settings });
type Admission = Awaited<ReturnType<typeof beginSessionEffect>>;
async function withAdmission<T>(admission: Admission, run: () => Promise<T>) {
  try {
    return await admission.run(run);
  } finally {
    admission.release();
  }
}

async function createArchiveSession(name: string, sessionId = `session-${name}`) {
  const storePath = path.join(sessionDirs.make(), "sessions.json");
  const sessionKey = `agent:main:${name}`;
  const target = { agentId: "main", sessionKey, storePath };
  const update = (entry: Parameters<typeof upsertSessionEntryCore>[1], key = sessionKey) =>
    upsertSessionEntryCore({ ...target, sessionKey: key }, entry);
  await update({ sessionId, updatedAt: 1 });
  return {
    storePath,
    sessionKey,
    sessionId,
    update,
    load: () => loadSessionEntry(target),
    events: (id = sessionId, key = sessionKey) =>
      loadTranscriptEvents({ ...target, sessionKey: key, sessionId: id }),
    createTool: (callGateway: AgentToolGatewayRequestCaller) =>
      createSessionsTool({
        agentSessionKey: sessionKey,
        agentSessionId: sessionId,
        config: { session: { store: storePath } },
        callGateway,
      }),
    beginAdmission: (id = sessionId) =>
      beginSessionEffect({
        scope: storePath,
        identities: [sessionKey, id],
        assertAllowed: () => {},
      }),
    archiveRequest: patchRequest(sessionKey, { archived: true, expectedSessionId: sessionId }),
  };
}

describe("sessions tool self-archive", () => {
  it.each(["current", "replaced", "revoked"])(
    "reports an unconfirmed deferred archive only to its authorized original generation (%s)",
    async (scenario) => {
      const replaced = scenario === "replaced";
      const controller = new AbortController();
      const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
      client.internal = {
        ...client.internal,
        operatorRunAuthority: authority("archive-requester", undefined, controller.signal),
      };
      const { storePath, sessionKey, sessionId, createTool, beginAdmission, update, events } =
        await createArchiveSession("archive-failure");
      const otherKey = "agent:main:other-session";
      await update({ sessionId: "other-session-id", updatedAt: 1 }, otherKey);
      const callGateway = vi.fn(async () => {
        if (replaced) {
          await update({ sessionId: "replacement-session-id", updatedAt: 2 });
        }
        if (scenario === "revoked") {
          controller.abort(new Error("archive source revoked"));
        }
        throw new Error("Transport failed: Bearer synthetic-private-token /private/session/path");
      });
      // Join the real detached continuation without replacing its reporting or storage owner.
      const continueInGateway = inProcessGateway.runWithGatewayToolContinuationContext;
      const pending: Promise<unknown>[] = [];
      const continuation = vi
        .spyOn(inProcessGateway, "runWithGatewayToolContinuationContext")
        .mockImplementation(<T>(run: () => Promise<T>) => {
          const work = continueInGateway(run);
          pending.push(work);
          return work;
        });
      const admission = await beginAdmission();
      try {
        let writerActive = true;
        const result = await withPluginRuntimeGatewayRequestScope(
          { client, isWebchatConnect: () => false },
          () =>
            withOwnedSessionTranscriptWrites(
              {
                sessionTarget: { agentId: "main", storePath, sessionKey, sessionId },
                assertCommitAllowed: () => {
                  if (!writerActive) {
                    throw new Error("model writer settled");
                  }
                },
                withTranscriptWrite: async (run) => await run(),
              },
              async () => await archive(createTool(callGateway as never), "archive-failure"),
            ),
        );
        writerActive = false;
        expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
        expect(callGateway).not.toHaveBeenCalled();
        admission.release();
        await Promise.allSettled(pending);

        expect(callGateway).toHaveBeenCalledTimes(1);
        const recorded = await events(replaced ? "replacement-session-id" : sessionId);
        if (scenario !== "current") {
          expect(recorded).toEqual([]);
        } else {
          expect(recorded).toContainEqual(
            expect.objectContaining({
              type: "custom_message",
              customType: "session-archive-failed",
              content:
                "The scheduled session archive could not be confirmed. Check whether this session is archived before trying again.",
              display: true,
              excludeFromContext: true,
              details: { operation: "archive", outcome: "unconfirmed" },
            }),
          );
          expect(JSON.stringify(recorded)).not.toContain("synthetic-private-token");
          expect(JSON.stringify(recorded)).not.toContain("/private/session/path");
        }
        expect(await events("other-session-id", otherKey)).toEqual([]);
      } finally {
        admission.release();
        continuation.mockRestore();
      }
    },
  );

  it("returns success before a detached dynamic-tool self-archive commits", async () => {
    const { sessionKey, sessionId, createTool, beginAdmission, archiveRequest, update, load } =
      await createArchiveSession("detached-self-archive");
    const runAbort = new AbortController();
    const archiveAbort = new Error("archive stopped the active turn");
    const callGateway = vi.fn(async () => {
      await update({ sessionId, updatedAt: 2, archivedAt: Date.now() });
      runAbort.abort(archiveAbort);
      return { ok: true };
    });
    const tool = createTool(callGateway as never);
    const admission = await beginAdmission();

    try {
      const projected = await Promise.race([
        archive(tool, "archive-current"),
        new Promise<never>((_resolve, reject) => {
          runAbort.signal.addEventListener("abort", () => reject(archiveAbort), {
            once: true,
          });
        }),
      ]);

      expect(projected.details).toMatchObject({ status: "scheduled", sessionKey });
      expect(callGateway).not.toHaveBeenCalled();
      expect(load()).not.toHaveProperty("archivedAt");
    } finally {
      admission.release();
    }

    await vi.waitFor(() => {
      expect(callGateway).toHaveBeenCalledExactlyOnceWith(archiveRequest);
      expect(load()).toHaveProperty("archivedAt");
    });
  });

  it("applies other self-patch settings before the deferred archive", async () => {
    const { sessionKey, sessionId, createTool, beginAdmission, archiveRequest } =
      await createArchiveSession("archive-patch");
    const labelRequest = patchRequest(sessionKey, {
      label: "Finished research",
      expectedSessionId: sessionId,
    });
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = createTool(callGateway as never);
    const admission = await beginAdmission();

    await withAdmission(admission, async () => {
      const result = await archive(tool, "archive-and-label", { label: "Finished research" });
      expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
      expect(callGateway).toHaveBeenCalledExactlyOnceWith(labelRequest);
    });

    await vi.waitFor(() => {
      expect(callGateway.mock.calls).toEqual([[labelRequest], [archiveRequest]]);
    });
  });

  it("does not apply a deferred archive to a replacement session", async () => {
    const { createTool, beginAdmission, update, load } = await createArchiveSession(
      "archive-replacement",
      "session-before-reset",
    );
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = createTool(callGateway as never);
    const admission = await beginAdmission();
    let replacementAdmission: Admission | undefined;

    await withAdmission(admission, async () => {
      await archive(tool, "archive-before-reset");
      await update({ sessionId: "session-after-reset", updatedAt: 2 });
      replacementAdmission = await beginAdmission("session-after-reset");
    });

    try {
      await nextTurn();
      expect(callGateway).not.toHaveBeenCalled();
      expect(load()).toMatchObject({ sessionId: "session-after-reset" });
      expect(load()).not.toHaveProperty("archivedAt");
    } finally {
      replacementAdmission?.release();
    }
  });

  it.each([
    { race: false, name: "waits for a competing turn before applying a scheduled archive" },
    { race: true, name: "retries a scheduled archive when a turn races the gateway mutation" },
  ])("$name", async ({ race }) => {
    const { sessionKey, createTool, beginAdmission, archiveRequest } = await createArchiveSession(
      race ? "archive-retry" : "archive-competing",
    );
    let competingAdmission: Admission | undefined;
    const callGateway = vi.fn(async () => {
      if (race && !competingAdmission) {
        competingAdmission = await beginAdmission();
        throw Object.assign(new Error("Session did not finish stopping."), { retryable: true });
      }
      return { ok: true };
    });
    const tool = createTool(callGateway as never);
    const currentAdmission = await beginAdmission();
    if (!race) {
      competingAdmission = await beginAdmission();
    }

    try {
      await withAdmission(currentAdmission, async () => {
        const result = await archive(
          tool,
          race ? "archive-after-race" : "archive-after-competition",
        );
        expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
      });
      if (race) {
        await vi.waitFor(() => {
          expect(callGateway).toHaveBeenCalledTimes(1);
          expect(competingAdmission).toBeDefined();
        });
      } else {
        await nextTurn();
        expect(callGateway).not.toHaveBeenCalled();
      }
    } finally {
      currentAdmission.release();
      competingAdmission?.release();
    }

    await vi.waitFor(() => {
      expect(callGateway).toHaveBeenCalledTimes(race ? 2 : 1);
      expect(callGateway).toHaveBeenLastCalledWith(archiveRequest);
    });
  });
});

it.each([false, true])(
  "withholds and rejects Stop when disabled by the host (sender is owner: %s)",
  async (senderIsOwner) => {
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      senderIsOwner,
      sessionControlAuthority: authority("collector-requester"),
      stopAllowed: false,
      callGateway,
    });
    expect(tool.parameters).toMatchObject({
      properties: {
        action: { enum: expect.not.arrayContaining(["stop"]) },
        archived: { type: "boolean" },
      },
    });
    expect(tool.parameters).not.toHaveProperty("properties.runId");
    expect(tool.parameters).not.toHaveProperty("properties.clearQueued");
    await expect(
      tool.execute("collector-stop", {
        action: "stop",
        sessionKey: "agent:main:dashboard:target",
      }),
    ).rejects.toThrow(/unavailable to non-interactive collectors/);
    expect(callGateway).not.toHaveBeenCalled();
  },
);

const sessionKey = "agent:main:main";
describe("sessions tool ownership", () => {
  it.each(["assignment", "rename", "sandbox"])(
    "explains archive unavailability as current authority context (%s)",
    async (surface) => {
      const tool = createSessionsTool({
        senderIsOwner: false,
        sandboxSessionRenameOnly: surface === "sandbox",
        sessionControlAuthority:
          surface === "rename"
            ? authority("rename-requester", ["operator.sessions.write"])
            : undefined,
      });
      if (surface === "sandbox") {
        expect(tool.description).toContain(
          "Archive and restore are unavailable in this authority context.",
        );
        expect(tool.parameters).not.toHaveProperty("properties.archived");
        return;
      }
      // Turn authority does not change the definition; the archive call is refused.
      expect(tool.description).toContain(
        "Turns without owner authority are limited when the action runs.",
      );
      await expect(tool.execute("archive", { action: "patch", archived: true })).rejects.toThrow(
        surface === "rename" ? /current operator write grant/ : /Only assign_owner/,
      );
    },
  );

  it.each([true, false])("assigns an owner with operator controls: %s", async (controls) => {
    const controller = new AbortController();
    const runAuthority = controls
      ? authority("profile-requester", undefined, controller.signal)
      : undefined;
    const actor = controls
      ? { type: "agent", id: "main" }
      : { type: "human", id: "profile-colin", label: "Colin" };
    const callGateway = vi.fn<AgentToolGatewayRequestCaller>().mockResolvedValue({
      ok: true,
      key: sessionKey,
      owner: {
        actor,
        assignedBy: { type: "agent", id: "main" },
        assignedAt: 10,
      },
    });
    await withSessionToolTestCaller(async () => {
      const tool = createSessionsTool({
        senderIsOwner: false,
        agentSessionKey: sessionKey,
        config: {},
        callGateway: callGateway as never,
      });
      const args = { action: "assign_owner", ownerType: actor.type, ownerId: actor.id };
      const assigned = await tool.execute("assign", args);
      expect(assigned.details).toMatchObject({ status: "updated", owner: actor });
      expect(callGateway).toHaveBeenCalledExactlyOnceWith({
        method: "sessions.assignOwner",
        params: { key: sessionKey, owner: { type: actor.type, id: actor.id } },
        agentToolCaller: { agentId: "main", sessionKey },
        assertDispatchCurrent: expect.any(Function),
      });
      if (!controls) {
        expect(assigned).toMatchObject({
          content: [{ type: "text", text: expect.stringContaining('"label": "Colin"') }],
        });
        return;
      }
      // The full definition stays stable; the control gate refuses settings when they run.
      expect(tool.parameters).toHaveProperty(
        "properties.action.enum",
        expect.arrayContaining(["patch", "stop", "assign_owner"]),
      );
      for (const denied of [
        { action: "group_set", names: [] },
        { action: "patch", archived: true, model: "other" },
      ]) {
        await expect(tool.execute("settings-denied", denied)).rejects.toThrow(
          /only permits archive, restore, and stop/,
        );
      }
      expect(callGateway).toHaveBeenCalledOnce();
      controller.abort(new Error("operator source revoked"));
      await expect(tool.execute("retired-assign", args)).rejects.toThrow("operator source revoked");
      expect(callGateway).toHaveBeenCalledOnce();
    }, runAuthority);
  });

  it.each([
    [false, "assign_owner", sessionKey, "requires an admitted agent turn"],
    [false, "patch", sessionKey, "Only assign_owner is available to non-owner callers"],
    [
      true,
      "assign_owner",
      "agent:main:dashboard:incognito-private",
      "Session not visible from session tools",
    ],
    [true, "assign_owner", "agent:other:main", "Session status visibility is restricted"],
  ] as const)(
    "non-owner admitted=%s action=%s target=%s rejects: %s",
    async (admitted, action, target, error) => {
      const callGateway = vi.fn();
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        senderIsOwner: false,
        config: admitted ? { tools: { sessions: { visibility: "agent" } } } : {},
        callGateway,
      });
      const invoke = () =>
        tool.execute("denied", {
          action,
          sessionKey: target,
          ownerType: "human",
          ownerId: "profile-colin",
          senderIsOwner: true,
        });
      await expect(admitted ? withSessionToolTestCaller(invoke) : invoke()).rejects.toThrow(error);
      expect(callGateway).not.toHaveBeenCalled();
    },
  );
});

it("patches and clears sidebar title, icon, group, status, attention, and archive state", async () => {
  const callGateway = vi.fn(async () => ({ ok: true }));
  const tool = createSessionsTool({
    agentSessionKey: "agent:main:main",
    agentSessionId: "session-main",
    config: {},
    callGateway: callGateway as never,
  });

  const settings = {
    label: "Waiting on staging",
    icon: "🦞",
    group: "P1 issues from beta feedback",
    statusNote: "Blocked: need the staging password",
    attention: "key",
    ttlMinutes: 45,
    archived: true,
  };
  await tool.execute("declare", { action: "patch", ...settings });
  await tool.execute("clear", {
    action: "patch",
    label: "",
    icon: "",
    group: "",
    attention: "clear",
  });
  await tool.execute("clear-null", { action: "patch", group: null });

  const { group, ...unchanged } = settings;
  expect(callGateway.mock.calls).toEqual(
    [
      { ...unchanged, category: group, expectedSessionId: "session-main" },
      { label: null, icon: null, category: null, attention: null },
      { category: null },
    ].map((params) => [patchRequest(sessionKey, params)]),
  );
});
