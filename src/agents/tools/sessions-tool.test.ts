import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionDecisionWork } from "../../audit/execution-decision-work.types.js";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { isAgentSessionModelPatchOrigin } from "../../gateway/session-model-patch-origin.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import * as failoverErrors from "../failover-error.js";
import { createAgentPatchedSessionModelRunGuard } from "../session-model-auto-revert.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { captureSessionDecisionWork as captureDecisionWork } from "./sessions-spawn-tool.decision.test-support.js";
import { createSessionsTool } from "./sessions-tool.js";
import {
  adversarialResolved,
  expectExactResolvedAcknowledgement,
  makeAgentPatchFallback,
} from "./sessions-tool.test-helpers.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-sessions-tool-");

const gatewayMocks = vi.hoisted(() => ({ callGateway: vi.fn() }));
vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: gatewayMocks.callGateway,
}));

beforeEach(() => {
  gatewayMocks.callGateway.mockReset();
});

type AgentToolGatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];

function captureSessionDecisionWork<T>(run: () => Promise<T>) {
  return captureDecisionWork(run, "sessions-tool");
}

function globalSessionConfig(): OpenClawConfig {
  return {
    session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: "ops" } },
      entries: { ops: {}, research: {} },
    },
  };
}

function mainTool(options: Parameters<typeof createSessionsTool>[0] = {}) {
  return createSessionsTool({ agentSessionKey: "agent:main:main", config: {}, ...options });
}

function visibleTool(callGateway: AgentToolGatewayRequestCaller) {
  return mainTool({ config: { tools: { sessions: { visibility: "agent" } } }, callGateway });
}

function expectGateway(
  callGateway: ReturnType<typeof vi.fn>,
  method: string,
  params: Record<string, unknown>,
) {
  expect(callGateway).toHaveBeenCalledWith({ method, params });
}

function expectReceipt(
  work: ExecutionDecisionWork[],
  operation: string,
  reasonCode: string,
  outcome = "allowed",
) {
  expect(work[0]?.receipt).toMatchObject({
    action: { family: "session", operation },
    decision: { outcome, reasonCode },
    enforcement: { coverageState: "attribution-only" },
  });
}

const finishedSession = {
  sessionKey: "agent:main:dashboard:finished",
  sessionId: "finished-session",
};
function archiveThenDelete(entry: Record<string, unknown>, deleted = true) {
  return vi.fn(async (request: { method: string }) =>
    request.method === "sessions.patch" ? { ok: true, entry } : { ok: true, deleted },
  );
}

async function modelSession(
  entry: Parameters<typeof upsertSessionEntryCore>[1],
  cfg: OpenClawConfig = {},
) {
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:main",
    storePath: path.join(sessionDirs.make(), "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: "session-main", updatedAt: 1, ...entry });
  return {
    scope,
    config: { ...cfg, session: { ...cfg.session, store: scope.storePath } },
    read: () => loadSessionEntry(scope),
    guard: () => createAgentPatchedSessionModelRunGuard({ cfg, ...scope }),
    patch: (patch: Parameters<typeof upsertSessionEntryCore>[1]) =>
      patchSessionEntryCore(scope, () => patch),
  };
}

function modelSelection(model: string, provider = "openai") {
  return { model, modelProvider: provider, modelOverride: model, providerOverride: provider };
}

describe("sessions tool", () => {
  it("paginates canonical owner profiles without exposing private directory fields", async () => {
    const profiles = Array.from({ length: 34 }, (_, index) => ({
      id: `person-${index}`,
      displayName: `Person ${index}`,
      mergedInto: null,
      githubIdentity: null,
      emails: ["private@example.test"],
      role: "admin",
    }));
    const callGateway = vi.fn().mockResolvedValue({
      profiles: [{ ...profiles[0], id: "merged-person", mergedInto: "person-0" }, ...profiles],
    });
    const tool = createSessionsTool({ senderIsOwner: true, callGateway });
    const first = await tool.execute("owners-first", { action: "owner_profiles" });
    expect(first.details).toMatchObject({ profiles: expect.any(Array), nextOffset: 32 });
    expect(JSON.stringify(first.details)).not.toMatch(/private@example|merged-person|"role"/);
    const second = await tool.execute("owners-next", { action: "owner_profiles", offset: 32 });
    expect(second.details).toEqual({
      profiles: [
        { id: "person-32", displayName: "Person 32", githubIdentity: null },
        { id: "person-33", displayName: "Person 33", githubIdentity: null },
      ],
    });
  });

  it("carries the persisted fixed-store owner for a bare patch key", async () => {
    const callGateway = vi.fn().mockResolvedValue({});
    const tool = createSessionsTool({
      agentSessionKey: "global",
      config: globalSessionConfig(),
      callGateway,
    });

    await tool.execute("owned-patch", { action: "patch", label: "Ops" });

    expectGateway(callGateway, "sessions.patch", {
      key: "global",
      agentId: "ops",
      label: "Ops",
    });
  });

  it("resolves current under the requester instead of the persisted bare-row owner", async () => {
    const callGateway = vi.fn().mockResolvedValue({ ok: true });
    const tool = createSessionsTool({
      agentSessionKey: "agent:research:main",
      requesterAgentIdOverride: "research",
      config: globalSessionConfig(),
      callGateway,
    });

    await tool.execute("research-current", {
      action: "patch",
      sessionKey: "current",
      label: "Research",
    });

    expectGateway(callGateway, "sessions.patch", {
      key: "agent:research:main",
      label: "Research",
    });
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.resolve" }),
    );
  });

  it("does not treat another agent's bare global row as self for patch", async () => {
    const requests: AgentToolGatewayRequest[] = [];
    const callGateway: AgentToolGatewayRequestCaller = async <T>(
      request: AgentToolGatewayRequest,
    ) => {
      requests.push(request);
      if (request.method === "sessions.resolve") {
        return { agentId: "ops", key: "global" } as T;
      }
      throw new Error(`unexpected gateway mutation: ${request.method}`);
    };
    const tool = createSessionsTool({
      agentSessionKey: "global",
      requesterAgentIdOverride: "research",
      config: {
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
        tools: { sessions: { visibility: "agent" } },
      },
      callGateway,
    });

    await expect(
      tool.execute("foreign-global-patch", {
        action: "patch",
        sessionKey: "2fb701ef-6425-4c48-9b6f-5a170aa2477e",
        label: "Ops",
      }),
    ).rejects.toThrow("Session status visibility is restricted");
    expect(requests).toContainEqual(expect.objectContaining({ method: "sessions.resolve" }));
    expect(
      requests.some((request) =>
        ["sessions.patch", "sessions.reset", "sessions.delete"].includes(request.method),
      ),
    ).toBe(false);
  });

  it("cannot patch an incognito session through the cross-session tool", async () => {
    const sessionKey = "agent:main:dashboard:incognito-private";
    const callGateway = vi.fn();
    const tool = createSessionsTool({
      agentSessionKey: sessionKey,
      config: {},
      callGateway,
    });

    await expect(
      tool.execute("incognito-patch", { action: "patch", label: "private" }),
    ).rejects.toThrow("Session not visible from session tools");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("does not accept independent creation through management actions", async () => {
    const callGateway = vi.fn();
    const tool = mainTool({ callGateway });

    await expect(tool.execute("create-uncontrolled-session", { action: "create" })).rejects.toThrow(
      "Unknown action: create",
    );
    expect(tool.parameters).not.toHaveProperty("properties.parentSessionKey");
    expect(tool.parameters).not.toHaveProperty("properties.agentId");
    expect(tool.parameters).not.toHaveProperty("properties.fork");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    { name: "archives before deletion", deleteTranscript: true, revision: "finished-revision" },
    { name: "preserves transcripts", deleteTranscript: false },
    { name: "rejects missing archive identity", missingIdentity: true },
  ])("$name", async (scenario) => {
    const { sessionKey, sessionId } = finishedSession;
    const entry = {
      sessionId,
      ...(scenario.revision ? { lifecycleRevision: scenario.revision } : {}),
    };
    const callGateway = scenario.missingIdentity
      ? vi.fn(async () => ({ ok: true }))
      : archiveThenDelete(entry, scenario.deleteTranscript);
    const tool = visibleTool(callGateway as never);
    const args = {
      action: "delete",
      sessionKey,
      expectedSessionId: sessionId,
      ...(scenario.deleteTranscript === false ? { deleteTranscript: false } : {}),
    };
    const archive = {
      method: "sessions.patch",
      params: { key: sessionKey, archived: true, expectedSessionId: sessionId },
    };
    if (scenario.missingIdentity) {
      await expect(tool.execute("delete", args)).rejects.toThrow(
        "archive did not return its session identity",
      );
      expect(callGateway.mock.calls).toEqual([[archive]]);
      return;
    }
    const { work } = await captureSessionDecisionWork(() => tool.execute("delete", args));
    expect(callGateway.mock.calls).toEqual([
      [archive],
      [
        {
          method: "sessions.delete",
          params: {
            key: sessionKey,
            archivedOnly: true,
            expectedSessionId: sessionId,
            ...(scenario.revision ? { expectedLifecycleRevision: scenario.revision } : {}),
            deleteTranscript: scenario.deleteTranscript,
          },
        },
      ],
    ]);
    expect(work).toHaveLength(1);
    expectReceipt(work, "delete", "session_delete_committed");
    if (scenario.revision) {
      expect(work[0]?.refs).toMatchObject({
        target: { namespace: "session", value: `["main","${sessionKey}"]` },
      });
    }
  });

  it("does not discover a lifecycle identity while deleting another session", async () => {
    const callGateway = vi.fn();
    const tool = visibleTool(callGateway);

    await expect(
      tool.execute("delete-without-identity", {
        action: "delete",
        sessionKey: "agent:main:dashboard:finished",
      }),
    ).rejects.toThrow("requires a durable session identity");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("resets another visible session through the canonical gateway method", async () => {
    const sessionKey = "agent:main:dashboard:reset-me";
    const callGateway = vi.fn(async () => ({ ok: true }));
    const tool = visibleTool(callGateway as never);

    const { work } = await captureSessionDecisionWork(() =>
      tool.execute("reset-session", { action: "reset", sessionKey }),
    );

    expectGateway(callGateway, "sessions.reset", { key: sessionKey, reason: "reset" });
    expectReceipt(work, "reset", "session_reset_committed");
  });

  it("records a committed restore result", async () => {
    gatewayMocks.callGateway.mockResolvedValue({
      ok: true,
      path: "/tmp/sessions.sqlite",
      key: "agent:main:main",
      entry: { sessionId: "session-main" },
    });
    const tool = mainTool({ agentSessionId: "session-main" });

    const { work } = await captureSessionDecisionWork(() =>
      tool.execute("committed-restore", { action: "patch", archived: false }),
    );

    expect(work).toHaveLength(1);
    expectReceipt(work, "restore", "session_restore_committed");
  });

  it("records a typed archive conflict", async () => {
    const callGateway: AgentToolGatewayRequestCaller = vi.fn(async () => {
      throw new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "arbitrary presentation text",
        retryable: false,
        details: { reason: "session-changed" },
      });
    });
    const tool = mainTool({ agentSessionId: "session-main", callGateway });

    const { work } = await captureSessionDecisionWork(async () => {
      await expect(
        tool.execute("conflict-archive", { action: "patch", archived: true }),
      ).rejects.toThrow("arbitrary presentation text");
    });

    expect(work).toHaveLength(1);
    expectReceipt(work, "archive", "session_archive_conflict", "denied");
  });

  it("drops a session result when receipt authority closes across its awaited RPC", async () => {
    const token = createExecutionIdentityAdmissionToken("sessions-tool-closed", {
      contextId: "sessions-tool-closed-context",
      executionId: "sessions-tool-closed-execution",
    });
    let authorityActive = true;
    gatewayMocks.callGateway.mockImplementation(async () => {
      authorityActive = false;
      return {
        ok: true,
        path: "/tmp/sessions.sqlite",
        key: "agent:main:main",
        entry: { sessionId: "session-main" },
      };
    });
    const tool = mainTool();
    const { work } = await captureSessionDecisionWork(() =>
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          executionIdentityToken: token,
          receiptAuthority: () => authorityActive,
        },
        () => tool.execute("closed-patch", { action: "patch", label: "Updated" }),
      ),
    );
    expect(gatewayMocks.callGateway).toHaveBeenCalledOnce();
    expect(work).toEqual([]);
  });

  it("refuses to delete its currently running session", async () => {
    const callGateway = vi.fn();
    const tool = mainTool({ callGateway });

    await expect(
      tool.execute("self-delete", { action: "delete", sessionKey: "agent:main:main" }),
    ).rejects.toThrow("Cannot delete the session running this tool");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("patches its session, then reverts a failed agent-selected model", async () => {
    const initialModel = {
      ...modelSelection("good"),
      modelOverrideSource: "auto" as const,
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "primary",
      authProfileOverride: "good-profile",
      authProfileOverrideSource: "user" as const,
      thinkingLevel: "high",
    };
    const session = await modelSession(initialModel, {
      agents: { defaults: { model: { primary: "openai/good" } } },
    });
    const sessionScope = session.scope;
    const { sessionKey } = sessionScope;
    const callGateway = vi.fn(
      async (request: { method: string; params: Record<string, unknown> }) => {
        expect(request.method).toBe("sessions.patch");
        expect(isAgentSessionModelPatchOrigin()).toBe(true);
        await patchSessionEntryCore(sessionScope, () => ({
          label: request.params.label as string,
          ...modelSelection("bad", "broken"),
          modelOverrideSource: "user",
          modelOverrideFallbackOriginProvider: undefined,
          modelOverrideFallbackOriginModel: undefined,
          authProfileOverride: "bad-profile",
          authProfileOverrideSource: "user",
          thinkingLevel: "low",
          modelFallback: {
            prevModel: "good",
            prevProvider: "openai",
            prevModelOverride: "good",
            prevProviderOverride: "openai",
            prevModelOverrideSource: "auto",
            prevModelOverrideFallbackOriginProvider: "openai",
            prevModelOverrideFallbackOriginModel: "primary",
            prevAuthProfileOverride: "good-profile",
            prevAuthProfileOverrideSource: "user",
            prevThinkingLevel: "high",
            ts: Date.now(),
            source: "agent-patch",
          },
        }));
        return { ok: true };
      },
    );
    const tool = mainTool({
      config: session.config,
      callGateway: callGateway as never,
    });
    const currentRunGuard = await session.guard();
    const failedCurrentRunGuard = await session.guard();

    await tool.execute("patch-model", {
      action: "patch",
      label: "Research",
      model: "broken/bad",
    });

    expectGateway(callGateway, "sessions.patch", {
      key: sessionKey,
      label: "Research",
      model: "broken/bad",
    });
    await currentRunGuard.finish(true);
    expect(loadSessionEntry(sessionScope)).toHaveProperty("modelFallback");

    const failure = { status: 404, message: "No endpoints found for broken/bad." };
    const entryBeforeFailure = loadSessionEntry(sessionScope);
    const transcriptScope = { ...sessionScope, sessionId: "session-main" };
    const transcriptBeforeFailure = await loadTranscriptEvents(transcriptScope);
    const classifyFailure = vi
      .spyOn(failoverErrors, "resolveFailoverReasonFromError")
      .mockImplementation(() => {
        throw new Error("An unarmed model-patch guard must not classify failures");
      });
    try {
      expect(failedCurrentRunGuard.captureFallbackFailure([])).toBeUndefined();
      expect(failedCurrentRunGuard.captureFailure(failure)).toBe(false);
      expect(
        failedCurrentRunGuard.captureFallbackFailure([
          { error: failure.message, reason: "model_not_found" },
        ]),
      ).toBe(false);
      await failedCurrentRunGuard.fail(failure);
      expect(classifyFailure).not.toHaveBeenCalled();
    } finally {
      classifyFailure.mockRestore();
    }
    expect(loadSessionEntry(sessionScope)).toEqual(entryBeforeFailure);
    expect(await loadTranscriptEvents(transcriptScope)).toEqual(transcriptBeforeFailure);

    const runGuard = await session.guard();
    await runGuard.fail(failure);
    expect(loadSessionEntry(sessionScope)).toMatchObject(initialModel);
    expect(loadSessionEntry(sessionScope)).not.toHaveProperty("modelFallback");
    const events = await loadTranscriptEvents(transcriptScope);
    expect(events).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          customType: "openclaw.system-note",
          content: "System note: model broken/bad failed; reverted to openai/good.",
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          customType: "openclaw.system-note",
          excludeFromContext: expect.anything(),
        }),
      }),
    );
  });

  it("denies model patches without in-process gateway context", async () => {
    const callGateway = vi.fn();
    const tool = mainTool({ callGateway, hasInProcessGatewayContext: () => false });

    const result = await tool.execute("patch-model", {
      action: "patch",
      model: "openai/gpt-5.4",
    });

    expect(result.details).toEqual({
      status: "forbidden",
      error: "Model patch needs in-process gateway.",
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([true, false])("settles the model marker after a successful run: %s", async (success) => {
    const session = await modelSession({
      ...(success ? {} : modelSelection("bad", "broken")),
      modelFallback: makeAgentPatchFallback("good", 1),
    });
    const runGuard = await session.guard();

    const needsRevert = success
      ? false
      : runGuard.captureFallbackFailure([
          { error: "No endpoints found for broken/bad.", reason: "model_not_found" },
          { error: "Fallback context overflow.", reason: "context_overflow" },
        ]);
    await runGuard.finish(!needsRevert);
    if (!success) {
      expect(session.read()).toMatchObject({ model: "good", modelProvider: "openai" });
    }
    expect(session.read()).not.toHaveProperty("modelFallback");
  });

  it("promotes the newest validated model across overlapping patches", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/a" } } },
    };
    const session = await modelSession(
      {
        ...modelSelection("b"),
        modelFallback: makeAgentPatchFallback("a", 10),
      },
      cfg,
    );
    const runB = await session.guard();
    await session.patch({
      model: "c",
      modelOverride: "c",
      modelFallback: makeAgentPatchFallback("a", 20),
    });
    const runC = await session.guard();
    await session.patch({
      model: "d",
      modelOverride: "d",
      modelFallback: makeAgentPatchFallback("a", 30),
    });
    const runD = await session.guard();

    await runC.finish(true);
    await runB.finish(true);
    expect(session.read()?.modelFallback).toMatchObject({
      prevModel: "c",
      prevProvider: "openai",
      lastValidatedPatchTs: 20,
      ts: 30,
    });

    await runD.fail({ status: 404, message: "No endpoints found for openai/d." });
    expect(session.read()).toMatchObject(modelSelection("c"));
  });

  it("keeps resolved model and thinking metadata when self-archive is deferred", async () => {
    const dir = sessionDirs.make();
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = "agent:main:subagent:archive-me";
    const sessionId = "archive-me-session";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt: 1 },
    );
    const callGateway = vi.fn(async () => ({
      ok: true as const,
      path: storePath,
      key: sessionKey,
      entry: { skillsSnapshot: "s".repeat(47_469) },
      resolved: adversarialResolved,
    }));
    const tool = createSessionsTool({
      agentSessionKey: sessionKey,
      agentSessionId: sessionId,
      config: { session: { store: storePath } },
      callGateway: callGateway as never,
    });
    const admission = await beginSessionEffect({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
    });

    try {
      const { result, work } = await captureSessionDecisionWork(() =>
        admission.run(() =>
          tool.execute("patch-model-thinking-archive", {
            action: "patch",
            archived: true,
            model: "openai/luna",
            thinkingLevel: "med",
          }),
        ),
      );
      expect(result.details).toEqual({
        status: "scheduled",
        sessionKey,
        message: "Session will be archived after the current agent run finishes.",
        resolved: adversarialResolved,
      });
      expectExactResolvedAcknowledgement(result, adversarialResolved);
      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(work).toHaveLength(1);
      expectReceipt(work, "archive", "session_archive_scheduled");
      expect(work[0]).toMatchObject({
        refs: { target: { namespace: "session", value: `["main","${sessionKey}"]` } },
      });
    } finally {
      admission.release();
    }

    await vi.waitFor(() => expect(callGateway).toHaveBeenCalledTimes(2));
    expect(callGateway).toHaveBeenNthCalledWith(1, {
      method: "sessions.patch",
      params: {
        key: sessionKey,
        model: "openai/luna",
        thinkingLevel: "med",
        expectedSessionId: sessionId,
      },
    });
    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "sessions.patch",
      params: {
        key: sessionKey,
        archived: true,
        expectedSessionId: sessionId,
      },
    });
  });

  it("rejects an empty patch", async () => {
    const callGateway = vi.fn();
    const tool = mainTool({ callGateway });

    await expect(tool.execute("patch-empty", { action: "patch" })).rejects.toThrow(
      "Patch setting required",
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([undefined, "tree"] as const)(
    "applies %s visibility when a non-main session categorizes a sibling",
    async (visibility) => {
      const callGateway = vi.fn(async () => ({ sessions: [] }));
      const tool = createSessionsTool({
        agentSessionKey: "agent:main:cron:organize",
        config: { tools: { sessions: { visibility } } },
        callGateway: callGateway as never,
      });
      const patch = tool.execute("patch-other", {
        action: "patch",
        sessionKey: "agent:main:other",
        group: "Projects",
      });
      if (visibility === "tree") {
        await expect(patch).rejects.toThrow("Session status visibility is restricted");
        expect(callGateway).not.toHaveBeenCalledWith({
          method: "sessions.patch",
          params: expect.objectContaining({ key: "agent:main:other" }),
        });
      } else {
        await patch;
        expectGateway(callGateway, "sessions.patch", {
          key: "agent:main:other",
          category: "Projects",
        });
      }
    },
  );
});
