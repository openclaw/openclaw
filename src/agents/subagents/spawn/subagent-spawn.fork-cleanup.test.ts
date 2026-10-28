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
  let tempDir: string;
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
  let observeSwarmSchedulerWork: typeof import("../swarm/swarm-scheduler.lifecycle.test-support.js").observeSwarmSchedulerWork;
  let schedulerWork: ReturnType<typeof observeSwarmSchedulerWork>;
  let restoreUpsert: () => void;
  let forkedEntry: SessionEntry | undefined;
  let initialForkVisibility: string | undefined;
  let visibilityDuringFork: "shared" | undefined;
  const registerSubagentRun = vi.fn();
  const startQueuedSubagentRun = vi.fn();
  const prepareSubagentSpawn = vi.fn();
  const dispatch = vi.fn();
  const scope = (sessionKey = parentKey) => ({
    agentId: "main",
    sessionKey,
    storePath,
  });
  const read = (sessionKey = parentKey) => sessions.loadSessionEntry(scope(sessionKey));
  const history = (sessionKey = parentKey, sessionId = parentId) =>
    sessions.loadTranscriptEvents({ ...scope(sessionKey), sessionId });
  const children = () => sessions.listSessionEntriesCore(scope());
  const spawn = (params: Parameters<SpawnSubagent>[0]) =>
    spawnSubagentDirect(params, { agentSessionKey: parentKey });
  const parentScope = () => ({ ...scope(), sessionId: parentId });
  const setParentTokens = (totalTokens: number) =>
    sessions.upsertSessionEntryCore(parentScope(), {
      totalTokens,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    });
  const expectNotLaunched = () => {
    expect(registerSubagentRun).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.some(([method]) => method === "agent")).toBe(false);
  };
  async function snapshotParent() {
    const entry = sessions.loadSessionEntry(parentScope());
    const transcript = await history();
    return async () => {
      expect(sessions.loadSessionEntry(parentScope())).toEqual(entry);
      expect(await history()).toEqual(transcript);
    };
  }
  function expectCopiedHistory(events: Awaited<ReturnType<typeof history>>) {
    expect(events).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ content: "parent history" }),
      }),
    );
  }
  const fork = vi.fn(async (input: unknown) => {
    const params = input as Parameters<ForkSession>[0];
    if (read()?.visibility === "draft") {
      initialForkVisibility = read(params.sessionKey)?.visibility ?? "shared";
    }
    if (visibilityDuringFork) {
      await sessions.upsertSessionEntryCore(scope(params.sessionKey), {
        visibility: visibilityDuringFork,
      });
    }
    const result = await forkSession(params);
    if (result.status === "forked") {
      forkedEntry = result.sessionEntry;
      expectCopiedHistory(await history(params.sessionKey, result.sessionEntry.sessionId));
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
        Object.fromEntries(children().map(({ sessionKey, entry }) => [sessionKey, entry])),
      get sessionStorePath() {
        return storePath;
      },
    }));
    sessions = await import("../../../config/sessions/session-accessor.js");
    ({ forkSessionEntryFromParent: forkSession } =
      await import("../../../auto-reply/reply/session-fork.js"));
    ({ observeSwarmSchedulerWork } =
      await import("../swarm/swarm-scheduler.lifecycle.test-support.js"));
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
    schedulerWork = observeSwarmSchedulerWork();
    tempDir = sessionDirs.make();
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
    initialForkVisibility = undefined;
    visibilityDuringFork = undefined;
    fork.mockClear();
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
        // Deletion transport is replaced: the same guard used by sessions.delete
        // decides whether the stored row and its transcript can actually be removed.
        const result = await sessions.deleteSessionEntryLifecycle({
          agentId: "main",
          storePath,
          target: { canonicalKey: key, storeKeys: [key] },
          expectedSessionId,
          expectedLifecycleRevision,
          archiveTranscript: deleteTranscript,
        });
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
      await sessions.appendTranscriptMessage({ ...scope(), sessionId: parentId }, { message });
    }
  });

  afterEach(() => schedulerWork.close());

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
    using _ = vi
      .spyOn(runtime, "resolveGatewaySessionStoreTargetInWorker")
      .mockImplementation(async (params) => {
        const child = children().find(({ sessionKey }) => sessionKey !== parentKey);
        if (child && params.key === parentKey) {
          provisional = child;
          throw new Error("fork lookup source unavailable");
        }
        return await resolveTarget(params);
      });

    await spawn({ task: "inspect parent history", context: "fork" }).catch(() => undefined);

    const created = expectDefined(provisional, "committed provisional child");
    expect(read(created.sessionKey)).toBeUndefined();
    expect(fork).not.toHaveBeenCalled();
    expectNotLaunched();
    expect(read()).toMatchObject({ sessionId: parentId, lifecycleRevision: "parent-revision" });
  });

  it("refuses an oversized fork when its created child disappears before preparation", async () => {
    await setParentTokens(150_000);
    let childSessionKey: string | undefined;
    fork.mockImplementationOnce(async (input: unknown) => {
      const params = input as Parameters<ForkSession>[0];
      childSessionKey = params.sessionKey;
      const child = expectDefined(read(childSessionKey), "created child before fork preparation");
      const deleted = await sessions.deleteSessionEntryLifecycle({
        agentId: "main",
        storePath,
        target: { canonicalKey: childSessionKey, storeKeys: [childSessionKey] },
        expectedSessionId: child.sessionId,
        expectedLifecycleRevision: child.lifecycleRevision,
        archiveTranscript: false,
      });
      expect(deleted.deleted).toBe(true);
      return await forkSession(params);
    });

    const result = await spawn({ task: "inspect parent history", context: "fork" });

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("could not fork the requester transcript"),
      childSessionKey: expectDefined(childSessionKey, "deleted child key"),
    });
    expectNotLaunched();
    expect(children()).toEqual([expect.objectContaining({ sessionKey: parentKey })]);
  });

  it.each(["fork", "isolated"] as const)(
    "protects locked parent transcript ownership with context=%s",
    async (context) => {
      prepareSubagentSpawn.mockResolvedValue(undefined);
      await sessions.upsertSessionEntryCore(parentScope(), { modelSelectionLocked: true });
      const expectParentUnchanged = await snapshotParent();

      const result = await spawn({ task: "do independent work", context });

      if (context === "fork") {
        expect(result).toMatchObject({
          status: "error",
          error:
            "Model-selection-locked sessions cannot create child sessions from parent context.",
        });
        expect(forkedEntry).toBeUndefined();
        expect(prepareSubagentSpawn).not.toHaveBeenCalled();
        expect(dispatch.mock.calls.some(([method]) => method === "agent")).toBe(false);
        expect(children().map(({ sessionKey }) => sessionKey)).toEqual([parentKey]);
      } else {
        expect(result.status).toBe("accepted");
        expect(fork).not.toHaveBeenCalled();
        const childSessionKey = expectDefined(result.childSessionKey, "isolated child key");
        const child = expectDefined(read(childSessionKey), "isolated child entry");
        expect(child.sessionId).not.toBe(parentId);
        expect(child.modelSelectionLocked).not.toBe(true);
        expect(await history(childSessionKey, child.sessionId)).toEqual([]);
      }
      await expectParentUnchanged();
    },
  );

  it.each([
    {
      scenario: "omitted context uses the thread-default fork",
      args: { thread: true },
      parentTokens: undefined,
      preparedMode: "fork",
      operation: "fork",
      changedChildVisibility: undefined,
    },
    {
      scenario: "a queued oversized fork starts isolated",
      args: { context: "fork", collect: true, groupId: "receipt-collectors" },
      parentTokens: 150_000,
      preparedMode: "isolated",
      operation: "create",
      changedChildVisibility: undefined,
    },
    {
      scenario: "the child is explicitly shared during fork preparation",
      args: { context: "fork" },
      parentTokens: undefined,
      preparedMode: "fork",
      operation: "fork",
      changedChildVisibility: "shared",
    },
  ] as const)(
    "records the committed context when $scenario",
    async ({ args, parentTokens, preparedMode, operation, changedChildVisibility }) => {
      await sessions.upsertSessionEntryCore(parentScope(), { visibility: "draft" });
      visibilityDuringFork = changedChildVisibility;
      prepareSubagentSpawn.mockResolvedValue(undefined);
      startQueuedSubagentRun.mockResolvedValue(true);
      threadBindingAvailable = true;
      config.logging = { audit: { enabled: true, executionIdentity: true } };
      if (parentTokens !== undefined) {
        await setParentTokens(parentTokens);
      }
      const expectParentUnchanged = await snapshotParent();
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
        const child = expectDefined(read(childSessionKey), "accepted child entry");
        expect(initialForkVisibility).toBe("draft");
        expect(child.visibility).toBe(changedChildVisibility ?? "draft");
        expect(prepareSubagentSpawn).toHaveBeenCalledWith(
          expect.objectContaining({
            contextMode: preparedMode,
            childSessionKey,
          }),
        );
        const childHistory = await history(childSessionKey, child.sessionId);
        if (preparedMode === "fork") {
          expect(child.forkedFromParent).toBe(true);
          expectCopiedHistory(childHistory);
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
      const expectParentUnchanged = await snapshotParent();
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
            const current = expectDefined(read(childSessionKey), "replacement entry");
            const successorScope = { ...childScope, sessionId: current.sessionId };
            await sessions.appendTranscriptMessage(successorScope, {
              message: { role: "user", content: "replacement work" },
            });
            successor = read(childSessionKey);
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
      expectNotLaunched();
      expect(rollback).toHaveBeenCalledOnce();
      const childSessionKey = expectDefined(childKey, "prepared child key");
      const entry = expectDefined(forkedEntry, "committed fork entry");
      expect(read(childSessionKey)).toEqual(successor);
      expect(await history(childSessionKey, successor?.sessionId ?? entry.sessionId)).toEqual(
        successorHistory,
      );
      await expectParentUnchanged();
    },
  );
});
