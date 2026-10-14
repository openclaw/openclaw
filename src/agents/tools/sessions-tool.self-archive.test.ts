import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsTool } from "./sessions-tool.js";
import { withSessionToolTestCaller } from "./sessions-tool.test-helpers.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sessions-tool-self-archive-");

async function createArchiveSession(dir: string, name: string, sessionId = `session-${name}`) {
  const storePath = path.join(dir, "sessions.json");
  const sessionKey = `agent:main:${name}`;
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey, storePath },
    { sessionId, updatedAt: 1 },
  );
  return {
    storePath,
    sessionKey,
    sessionId,
    createTool: (callGateway: AgentToolGatewayRequestCaller) =>
      createSessionsTool({
        agentSessionKey: sessionKey,
        agentSessionId: sessionId,
        config: { session: { store: storePath } },
        callGateway,
      }),
    beginAdmission: (id = sessionId) =>
      beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, id],
        assertAllowed: () => {},
      }),
    archiveRequest: {
      method: "sessions.patch",
      params: { key: sessionKey, archived: true, expectedSessionId: sessionId },
    },
  };
}

describe("sessions tool self-archive", () => {
  it("returns success before a detached dynamic-tool self-archive commits", async () => {
    const dir = sessionDirs.make();
    const { storePath, sessionKey, sessionId, createTool, beginAdmission, archiveRequest } =
      await createArchiveSession(dir, "detached-self-archive");
    const runAbort = new AbortController();
    const callGateway = vi.fn(async () => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 2, archivedAt: Date.now() },
      );
      runAbort.abort(new Error("archive stopped the active turn"));
      return { ok: true };
    });
    const tool = createTool(callGateway as never);
    const admission = await beginAdmission();

    try {
      const projected = await Promise.race([
        tool.execute("archive-current", { action: "patch", archived: true }).then((result) => ({
          success: true as const,
          result,
        })),
        new Promise<{ success: false }>((resolve) => {
          runAbort.signal.addEventListener("abort", () => resolve({ success: false }), {
            once: true,
          });
        }),
      ]);

      expect(projected.success).toBe(true);
      if (projected.success) {
        expect(projected.result.details).toMatchObject({
          status: "scheduled",
          sessionKey,
        });
      }
      expect(callGateway).not.toHaveBeenCalled();
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
        "archivedAt",
      );
    } finally {
      admission.release();
    }

    await vi.waitFor(() => {
      expect(callGateway).toHaveBeenCalledExactlyOnceWith(archiveRequest);
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toHaveProperty(
        "archivedAt",
      );
    });
  });

  it("applies other self-patch settings before the deferred archive", async () => {
    const dir = sessionDirs.make();
    const { sessionKey, sessionId, createTool, beginAdmission } = await createArchiveSession(
      dir,
      "archive-patch",
    );
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = createTool(callGateway as never);
    const admission = await beginAdmission();

    try {
      await admission.run(async () => {
        const result = await tool.execute("archive-and-label", {
          action: "patch",
          label: "Finished research",
          archived: true,
        });
        expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
        expect(callGateway).toHaveBeenCalledExactlyOnceWith({
          method: "sessions.patch",
          params: {
            key: sessionKey,
            label: "Finished research",
            expectedSessionId: sessionId,
          },
        });
      });
    } finally {
      admission.release();
    }

    await vi.waitFor(() => {
      expect(callGateway.mock.calls).toEqual([
        [
          {
            method: "sessions.patch",
            params: { key: sessionKey, label: "Finished research", expectedSessionId: sessionId },
          },
        ],
        [
          {
            method: "sessions.patch",
            params: { key: sessionKey, archived: true, expectedSessionId: sessionId },
          },
        ],
      ]);
    });
  });

  it("does not apply a deferred archive to a replacement session", async () => {
    const dir = sessionDirs.make();
    const { storePath, sessionKey, createTool, beginAdmission } = await createArchiveSession(
      dir,
      "archive-replacement",
      "session-before-reset",
    );
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = createTool(callGateway as never);
    const admission = await beginAdmission();
    let replacementAdmission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;

    try {
      await admission.run(async () => {
        await tool.execute("archive-before-reset", { action: "patch", archived: true });
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey, storePath },
          { sessionId: "session-after-reset", updatedAt: 2 },
        );
        replacementAdmission = await beginAdmission("session-after-reset");
      });
    } finally {
      admission.release();
    }

    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(callGateway).not.toHaveBeenCalled();
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        sessionId: "session-after-reset",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
        "archivedAt",
      );
    } finally {
      replacementAdmission?.release();
    }
  });

  it("waits for a competing turn before applying a scheduled archive", async () => {
    const dir = sessionDirs.make();
    const { sessionKey, createTool, beginAdmission, archiveRequest } = await createArchiveSession(
      dir,
      "archive-competing",
    );
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = createTool(callGateway as never);
    const currentAdmission = await beginAdmission();
    const competingAdmission = await beginAdmission();

    try {
      await currentAdmission.run(async () => {
        const result = await tool.execute("archive-after-competition", {
          action: "patch",
          archived: true,
        });
        expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
      });
      currentAdmission.release();

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(callGateway).not.toHaveBeenCalled();
    } finally {
      currentAdmission.release();
      competingAdmission.release();
    }

    await vi.waitFor(() => {
      expect(callGateway).toHaveBeenCalledExactlyOnceWith(archiveRequest);
    });
  });

  it("retries a scheduled archive when a turn races the gateway mutation", async () => {
    const dir = sessionDirs.make();
    const { sessionKey, createTool, beginAdmission, archiveRequest } = await createArchiveSession(
      dir,
      "archive-retry",
    );
    let competingAdmission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    const callGateway = vi.fn(async () => {
      if (!competingAdmission) {
        competingAdmission = await beginAdmission();
        throw Object.assign(new Error("Session did not finish stopping."), { retryable: true });
      }
      return { ok: true };
    });
    const tool = createTool(callGateway as never);
    const currentAdmission = await beginAdmission();

    try {
      await currentAdmission.run(async () => {
        const result = await tool.execute("archive-after-race", {
          action: "patch",
          archived: true,
        });
        expect(result.details).toMatchObject({ status: "scheduled", sessionKey });
      });
      currentAdmission.release();

      await vi.waitFor(() => {
        expect(callGateway).toHaveBeenCalledTimes(1);
        expect(competingAdmission).toBeDefined();
      });
    } finally {
      currentAdmission.release();
      competingAdmission?.release();
    }

    await vi.waitFor(() => {
      expect(callGateway).toHaveBeenCalledTimes(2);
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
      sessionControlAuthority: createAdmittedRunOperatorAuthority({
        profileId: "collector-requester",
        scopes: ["operator.write"],
        assertCurrent: () => {},
      }),
      stopAllowed: false,
      callGateway,
    });
    expect(tool.parameters).toMatchObject({
      properties: { action: { enum: expect.not.arrayContaining(["stop"]) } },
    });
    expect(tool.parameters).not.toHaveProperty("properties.runId");
    expect(tool.parameters).not.toHaveProperty("properties.clearQueued");
    expect(tool.parameters).toMatchObject({ properties: { archived: { type: "boolean" } } });
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
  it.each([
    { senderIsOwner: false, controls: true },
    { senderIsOwner: false, controls: false },
  ])("assigns an owner with posture %j", async ({ senderIsOwner, controls }) => {
    const controller = new AbortController();
    const authority = controls
      ? createAdmittedRunOperatorAuthority({
          profileId: "profile-requester",
          scopes: ["operator.write"],
          signal: controller.signal,
          assertCurrent: () => {},
        })
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
        senderIsOwner,
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
      expect(tool.parameters).toHaveProperty("properties.action.enum", [
        "patch",
        "stop",
        "assign_owner",
      ]);
      expect(tool.parameters).toHaveProperty("properties.user");
      expect(tool.parameters).not.toHaveProperty("properties.model");
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
    }, authority);
  });

  it.each([
    {
      senderIsOwner: false,
      admitted: false,
      action: "assign_owner",
      target: sessionKey,
      error: "requires an admitted agent turn",
    },
    {
      senderIsOwner: false,
      admitted: false,
      action: "patch",
      target: sessionKey,
      error: "Only assign_owner is available to non-owner callers",
    },
    ...[
      {
        target: "agent:main:dashboard:incognito-private",
        error: "Session not visible from session tools",
      },
      { target: "agent:other:main", error: "Session status visibility is restricted" },
    ].map(({ target, error }) => ({
      target,
      error,
      senderIsOwner: false,
      admitted: true,
      action: "assign_owner",
    })),
  ])(
    "denies $action for $target (admitted: $admitted, owner: $senderIsOwner)",
    async ({ senderIsOwner, admitted, action, target, error }) => {
      const callGateway = vi.fn();
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        senderIsOwner,
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

describe("sessions tool sidebar settings", () => {
  it("patches and clears title, icon, group, status, attention, and archive state", async () => {
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = createSessionsTool({
      agentSessionKey: "agent:main:main",
      agentSessionId: "session-main",
      config: {},
      callGateway: callGateway as never,
    });

    await tool.execute("declare", {
      action: "patch",
      label: "Waiting on staging",
      icon: "🦞",
      group: "P1 issues from beta feedback",
      statusNote: "Blocked: need the staging password",
      attention: "key",
      ttlMinutes: 45,
      archived: true,
    });
    await tool.execute("clear", {
      action: "patch",
      label: "",
      icon: "",
      group: "",
      attention: "clear",
    });
    await tool.execute("clear-null", { action: "patch", group: null });

    expect(callGateway.mock.calls).toEqual([
      [
        {
          method: "sessions.patch",
          params: {
            key: "agent:main:main",
            label: "Waiting on staging",
            icon: "🦞",
            category: "P1 issues from beta feedback",
            statusNote: "Blocked: need the staging password",
            attention: "key",
            ttlMinutes: 45,
            archived: true,
            expectedSessionId: "session-main",
          },
        },
      ],
      [
        {
          method: "sessions.patch",
          params: {
            key: "agent:main:main",
            label: null,
            icon: null,
            category: null,
            attention: null,
          },
        },
      ],
      [
        {
          method: "sessions.patch",
          params: {
            key: "agent:main:main",
            category: null,
          },
        },
      ],
    ]);
  });
});
