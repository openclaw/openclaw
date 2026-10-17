import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionDecisionWork } from "../../../audit/execution-decision-work.types.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { useSessionStoreTempDirs } from "../../../test-utils/session-state-cleanup.js";
import { loadSubagentSpawnModuleForTest } from "./subagent-spawn.test-helpers.js";

type ForkSession =
  typeof import("../../../auto-reply/reply/session-fork.js").forkSessionEntryFromParent;
type SpawnSubagent = typeof import("./subagent-spawn.js").spawnSubagentDirect;

describe("subagent fork context through SQLite and tool boundaries", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-fork-cleanup-");
  const parentKey = "agent:main:main";
  const parentId = "parent-session";
  let storePath: string;
  let config: OpenClawConfig;
  let threadBindingAvailable: boolean;
  let sessions: typeof import("../../../config/sessions/session-accessor.js");
  let forkSession: ForkSession;
  let spawnSubagentDirect: SpawnSubagent;
  let createSessionsSpawnTool: typeof import("../../tools/sessions-spawn-tool.js").createSessionsSpawnTool;
  let createAgentsWaitTool: typeof import("../../tools/agents-wait-tool.js").createAgentsWaitTool;
  let finalizeAgentToolAvailability: typeof import("../../agent-tool-availability.js").finalizeAgentToolAvailability;
  let decisionWork: typeof import("../../../audit/execution-decision-work.js");
  let identityAdmission: typeof import("../../../audit/execution-identity-admission.js");
  let callerContext: typeof import("../../tools/gateway-caller-context.js");
  let resetScheduler: () => void;
  let restoreUpsert: () => void;
  let forkedEntry: SessionEntry | undefined;
  const registerSubagentRun = vi.fn();
  const startQueuedSubagentRun = vi.fn();
  const prepareSubagentSpawn = vi.fn();
  const dispatch = vi.fn();
  const scope = (sessionKey = parentKey) => ({
    agentId: "main",
    sessionKey,
    storePath,
  });
  const parentScope = () => ({ ...scope(), sessionId: parentId });
  const loadEntry = (key: string) => sessions.loadSessionEntry(scope(key));
  const requireEntry = (key: string) => expectDefined(loadEntry(key), "session entry");
  const loadHistory = (key: string, sessionId: string) =>
    sessions.loadTranscriptEvents({ ...scope(key), sessionId });
  const markOversized = () =>
    sessions.upsertSessionEntryCore(parentScope(), {
      totalTokens: 150_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    });
  const listEntries = () => sessions.listSessionEntriesCore({ agentId: "main", storePath });
  const deleteEntry = (
    key: string,
    entry: Pick<SessionEntry, "sessionId" | "lifecycleRevision">,
    archiveTranscript: boolean,
  ) =>
    sessions.deleteSessionEntryLifecycle({
      agentId: "main",
      storePath,
      target: { canonicalKey: key, storeKeys: [key] },
      expectedSessionId: entry.sessionId,
      expectedLifecycleRevision: entry.lifecycleRevision,
      archiveTranscript,
    });
  const parentHistory = expect.arrayContaining([
    expect.objectContaining({ message: expect.objectContaining({ content: "parent history" }) }),
  ]);
  const spawnFork = () =>
    spawnSubagentDirect(
      { task: "inspect parent history", context: "fork" },
      { agentSessionKey: parentKey },
    );
  function expectNoLaunch() {
    expect(registerSubagentRun).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.some(([method]) => method === "agent")).toBe(false);
  }
  function expectDeletion(key: string, entry: SessionEntry) {
    expect(dispatch).toHaveBeenCalledWith(
      "sessions.delete",
      expect.objectContaining({
        key,
        expectedSessionId: entry.sessionId,
        expectedLifecycleRevision: entry.lifecycleRevision,
      }),
      expect.anything(),
    );
  }
  async function preserveParent() {
    const entry = loadEntry(parentKey);
    const history = await loadHistory(parentKey, parentId);
    return async () => {
      expect(loadEntry(parentKey)).toEqual(entry);
      expect(await loadHistory(parentKey, parentId)).toEqual(history);
    };
  }
  const fork = vi.fn<ForkSession>(async (params) => {
    const result = await forkSession(params);
    if (result.status === "forked") {
      forkedEntry = result.sessionEntry;
      expect(await loadHistory(params.sessionKey, result.sessionEntry.sessionId)).toEqual(
        parentHistory,
      );
    }
    return result;
  });

  beforeAll(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: vi.fn(() => {
        throw new Error("unexpected external Gateway call");
      }),
      hasInProcessGatewayContextMock: () => true,
      dispatchGatewayMethodInProcessMock: dispatch,
      forkSessionEntryFromParentMock: fork,
      registerSubagentRunMock: registerSubagentRun,
      startQueuedSubagentRunMock: startQueuedSubagentRun,
      resolveContextEngineMock: async () => ({ prepareSubagentSpawn }),
      getRuntimeConfig: () => config,
      getSessionBindingService: () => ({
        getCapabilities: () => ({
          adapterAvailable: threadBindingAvailable,
          bindSupported: threadBindingAvailable,
          placements: ["child"],
        }),
        bind: async (request) => ({
          targetSessionKey: request.targetSessionKey,
          status: "active",
          conversation: {
            channel: request.conversation.channel,
            accountId: request.conversation.accountId,
            conversationId: "fork-receipt-thread",
          },
        }),
        listBySession: () => [],
      }),
      loadSessionStoreMock: () =>
        Object.fromEntries(listEntries().map(({ sessionKey, entry }) => [sessionKey, entry])),
      get sessionStorePath() {
        return storePath;
      },
    }));
    sessions = await import("../../../config/sessions/session-accessor.js");
    ({ forkSessionEntryFromParent: forkSession } =
      await import("../../../auto-reply/reply/session-fork.js"));
    const { testing } = await import("../swarm/swarm-scheduler.test-support.js");
    resetScheduler = () => testing.reset();
    const runtime = await import("./subagent-spawn.runtime.js");
    const upsert = vi
      .spyOn(runtime, "upsertSessionEntryCore")
      .mockImplementation(sessions.upsertSessionEntryCore);
    restoreUpsert = () => upsert.mockRestore();
    ({ createSessionsSpawnTool } = await import("../../tools/sessions-spawn-tool.js"));
    ({ createAgentsWaitTool } = await import("../../tools/agents-wait-tool.js"));
    ({ finalizeAgentToolAvailability } = await import("../../agent-tool-availability.js"));
    decisionWork = await import("../../../audit/execution-decision-work.js");
    identityAdmission = await import("../../../audit/execution-identity-admission.js");
    callerContext = await import("../../tools/gateway-caller-context.js");
  });

  beforeEach(async () => {
    const tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "sessions.json");
    config = {
      session: { store: storePath, mainKey: "main", scope: "per-sender" },
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: {
        defaults: { workspace: tempDir, model: { primary: "openai/gpt-5.6-luna" } },
      },
    };
    threadBindingAvailable = false;
    forkedEntry = undefined;
    fork.mockClear();
    resetScheduler();
    registerSubagentRun.mockReset().mockResolvedValue(undefined);
    startQueuedSubagentRun.mockReset().mockResolvedValue(false);
    prepareSubagentSpawn.mockReset();
    dispatch
      .mockReset()
      .mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === "agent") {
          return { runId: "accepted-child-run", status: "accepted" };
        }
        if (method === "chat.abort") {
          throw new Error("abort unavailable");
        }
        if (method !== "sessions.delete") {
          throw new Error(`unexpected Gateway method ${method}`);
        }
        const { key, expectedSessionId, expectedLifecycleRevision, deleteTranscript } = params as {
          key: string;
          expectedSessionId: string;
          expectedLifecycleRevision: string;
          deleteTranscript: boolean;
        };
        expect(expectedSessionId).toEqual(expect.any(String));
        expect(expectedLifecycleRevision).toEqual(expect.any(String));
        // Deletion transport is replaced: the same guard used by sessions.delete
        // decides whether the stored row and its transcript can actually be removed.
        const result = await deleteEntry(
          key,
          { sessionId: expectedSessionId, lifecycleRevision: expectedLifecycleRevision },
          deleteTranscript,
        );
        if (result.expectedEntryMismatch) {
          throw Object.assign(new Error("session changed"), {
            name: "GatewayClientRequestError",
            gatewayCode: "INVALID_REQUEST",
            details: { reason: "session-changed" },
          });
        }
        return result;
      });
    await sessions.replaceSessionEntry(scope(), {
      sessionId: parentId,
      lifecycleRevision: "parent-revision",
      updatedAt: Date.now(),
    });
    // Seed a completed exchange so injected failures happen after a real history fork.
    for (const message of [
      { role: "user", content: "parent history" },
      { role: "assistant", content: "parent answer", stopReason: "stop" },
    ]) {
      await sessions.appendTranscriptMessage(parentScope(), { message });
    }
  });

  afterEach(() => resetScheduler());

  afterAll(() => {
    restoreUpsert();
    vi.doUnmock("./subagent-spawn.runtime.js");
    vi.doUnmock("./subagent-depth.js");
    vi.doUnmock("../registry/subagent-registry.js");
    vi.doUnmock("../../provider-model-normalization.runtime.js");
  });

  it("cleans up the provisional child when fork parent lookup rejects", async () => {
    const runtime = await import("./subagent-spawn.runtime.js");
    const resolveTarget = runtime.resolveGatewaySessionStoreTargetInWorker;
    let provisional: { sessionKey: string; entry: SessionEntry } | undefined;
    const selected = vi
      .spyOn(runtime, "resolveGatewaySessionStoreTargetInWorker")
      .mockImplementation(async (params) => {
        const child = listEntries().find(({ sessionKey }) => sessionKey !== parentKey);
        if (child && params.key === parentKey) {
          provisional = child;
          throw new Error("fork lookup source unavailable");
        }
        return await resolveTarget(params);
      });
    try {
      await spawnFork().catch(() => undefined);

      const created = expectDefined(provisional, "committed provisional child");
      expect(loadEntry(created.sessionKey)).toBeUndefined();
      expectDeletion(created.sessionKey, created.entry);
      expect(fork).not.toHaveBeenCalled();
      expectNoLaunch();
      expect(loadEntry(parentKey)).toMatchObject({
        sessionId: parentId,
        lifecycleRevision: "parent-revision",
      });
    } finally {
      selected.mockRestore();
    }
  });

  it("refuses an oversized fork when its created child disappears before preparation", async () => {
    await markOversized();
    let childSessionKey: string | undefined;
    fork.mockImplementationOnce(async (params) => {
      childSessionKey = params.sessionKey;
      const child = requireEntry(childSessionKey);
      const deleted = await deleteEntry(childSessionKey, child, false);
      expect(deleted.deleted).toBe(true);
      return await forkSession(params);
    });

    const result = await spawnFork();

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("could not fork the requester transcript"),
      childSessionKey: expectDefined(childSessionKey, "deleted child key"),
    });
    expectNoLaunch();
    expect(listEntries()).toEqual([expect.objectContaining({ sessionKey: parentKey })]);
  });

  it.each(["fork", "isolated"] as const)(
    "protects locked parent transcript ownership with context=%s",
    async (context) => {
      await sessions.upsertSessionEntryCore(parentScope(), {
        modelSelectionLocked: true,
      });
      const expectParentUnchanged = await preserveParent();

      const result = await spawnSubagentDirect(
        { task: "do independent work", context },
        { agentSessionKey: parentKey },
      );

      if (context === "fork") {
        expect(result).toMatchObject({
          status: "error",
          error:
            "Model-selection-locked sessions cannot create child sessions from parent context.",
        });
        expect(forkedEntry).toBeUndefined();
        expect(prepareSubagentSpawn).not.toHaveBeenCalled();
        expect(dispatch.mock.calls.some(([method]) => method === "agent")).toBe(false);
        expect(listEntries().map(({ sessionKey }) => sessionKey)).toEqual([parentKey]);
      } else {
        expect(result.status).toBe("accepted");
        expect(fork).not.toHaveBeenCalled();
        const childSessionKey = expectDefined(result.childSessionKey, "isolated child key");
        const child = requireEntry(childSessionKey);
        expect(child.sessionId).not.toBe(parentId);
        expect(child.modelSelectionLocked).not.toBe(true);
        expect(await loadHistory(childSessionKey, child.sessionId)).toEqual([]);
      }
      await expectParentUnchanged();
    },
  );

  it.each([
    ["omitted context uses the thread-default fork", { thread: true }, "fork", "fork"],
    [
      "a queued oversized fork starts isolated",
      { context: "fork", collect: true, groupId: "receipt-collectors" },
      "isolated",
      "create",
    ],
  ] as const)(
    "records the committed context when %s",
    async (_scenario, args, preparedMode, operation) => {
      startQueuedSubagentRun.mockResolvedValue(true);
      threadBindingAvailable = true;
      config.logging = { audit: { enabled: true, executionIdentity: true } };
      if (preparedMode === "isolated") {
        await markOversized();
      }
      const expectParentUnchanged = await preserveParent();
      const work: ExecutionDecisionWork[] = [];
      const token = identityAdmission.createExecutionIdentityAdmissionToken("receipt-parent-run", {
        contextId: "receipt-parent-context",
        executionId: "receipt-parent-execution",
      });
      const tool = createSessionsSpawnTool({
        config,
        agentSessionKey: parentKey,
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:123",
      });
      const wait = createAgentsWaitTool({ config, agentSessionKey: parentKey, agentId: "main" });
      finalizeAgentToolAvailability([tool, wait]);
      const clearSink = decisionWork.configureExecutionDecisionWorkSink((item) => {
        work.push(decisionWork.parseExecutionDecisionWork(item));
        return true;
      });
      try {
        const result = await callerContext.withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: parentKey,
            executionIdentityToken: token,
            receiptAuthority: () => true,
          },
          () => tool.execute("spawn-context-receipt", { task: "inspect parent history", ...args }),
        );

        expect(result.details).toMatchObject({ status: "accepted", context: preparedMode });
        if ("collect" in args) {
          await vi.waitFor(() => expect(startQueuedSubagentRun).toHaveBeenCalled());
        }
        const childSessionKey = expectDefined(
          (result.details as { childSessionKey?: string }).childSessionKey,
          "accepted child key",
        );
        const child = requireEntry(childSessionKey);
        expect(prepareSubagentSpawn).toHaveBeenCalledWith(
          expect.objectContaining({
            contextMode: preparedMode,
            childSessionKey,
          }),
        );
        const childHistory = await loadHistory(childSessionKey, child.sessionId);
        if (preparedMode === "fork") {
          expect(child.forkedFromParent).toBe(true);
          expect(childHistory).toEqual(parentHistory);
        } else {
          expect(forkedEntry).toBeUndefined();
          expect(childHistory).toEqual([]);
          expect(result.details).toMatchObject({
            note: expect.stringContaining("Parent context is too large to fork"),
          });
        }
        await expectParentUnchanged();
        expect(JSON.stringify(result.details)).not.toContain("receipt-parent-context");
        expect(work).toHaveLength(1);
        expect(work[0]).toMatchObject({
          token,
          receipt: {
            action: { family: "session", operation },
            decision: { outcome: "allowed", reasonCode: `session_${operation}_committed` },
            enforcement: { coverageState: "attribution-only" },
            source: { owner: "session-action", decisionBoundary: "session-tool.result" },
          },
          refs: {
            target: { namespace: "session", value: JSON.stringify(["main", childSessionKey]) },
          },
        });
      } finally {
        clearSink();
      }
    },
  );

  it.each(["no replacement", "session id", "lifecycle revision"] as const)(
    "cleans up the committed fork after source closure with %s",
    async (replacement) => {
      let active = true;
      let childKey: string | undefined;
      let successor: SessionEntry | undefined;
      let successorHistory: Awaited<ReturnType<typeof sessions.loadTranscriptEvents>> = [];
      const rollback = vi.fn();
      const expectParentUnchanged = await preserveParent();
      prepareSubagentSpawn.mockImplementation(
        async ({ childSessionKey }: { childSessionKey: string }) => {
          const entry = expectDefined(forkedEntry, "committed fork entry");
          childKey = childSessionKey;
          if (replacement !== "no replacement") {
            const childScope = scope(childSessionKey);
            await sessions.replaceSessionEntry(childScope, {
              ...entry,
              ...(replacement === "session id"
                ? { sessionId: "replacement-session" }
                : { lifecycleRevision: "replacement-revision" }),
            });
            const current = requireEntry(childSessionKey);
            const successorScope = { ...childScope, sessionId: current.sessionId };
            await sessions.appendTranscriptMessage(successorScope, {
              message: { role: "user", content: "replacement work" },
            });
            successor = loadEntry(childSessionKey);
            successorHistory = await sessions.loadTranscriptEvents(successorScope);
          }
          active = false;
          return { rollback };
        },
      );
      const tool = createSessionsSpawnTool({ config, agentSessionKey: parentKey });
      const result = await callerContext.withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: parentKey, receiptAuthority: () => active },
        () =>
          tool.execute("closed-fork-source", { task: "inspect parent history", context: "fork" }),
      );

      expect(result.details).toMatchObject({
        status: "error",
        error: "tool invocation authority is no longer active",
      });
      expectNoLaunch();
      expect(rollback).toHaveBeenCalledOnce();
      const childSessionKey = expectDefined(childKey, "prepared child key");
      const entry = expectDefined(forkedEntry, "committed fork entry");
      expectDeletion(childSessionKey, entry);
      expect(loadEntry(childSessionKey)).toEqual(successor);
      expect(await loadHistory(childSessionKey, successor?.sessionId ?? entry.sessionId)).toEqual(
        successorHistory,
      );
      await expectParentUnchanged();
    },
  );
});
