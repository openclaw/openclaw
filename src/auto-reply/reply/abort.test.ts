// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "../../gateway/server-methods/chat.abort-registry.test-support.js";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { isSubagentRegistryWriteCommand } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { rowToSubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.store.codec.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  markSessionAbortTarget,
  replaceSessionEntry,
  resolveSessionAbortTarget,
  type SessionAbortTargetResult,
} from "../../config/sessions/session-accessor.js";
import { registerInternalHook, unregisterInternalHook } from "../../hooks/internal-hooks.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { isSessionRunActiveForKey } from "../../sessions/session-controller.queries.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { stopSubagentsForRequester } from "./abort-operation.js";
import { getAbortMemory, setAbortMemory } from "./abort-primitives.js";
import {
  addSubagentFixture,
  type SubagentRunFixture,
} from "./abort-subagent-registry.test-support.js";
import { registerAbortAcpCases } from "./abort.acp.cases.js";
import { registerAbortDetectionCases } from "./abort.detection.cases.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./abort.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { buildTestCtx } from "./test-ctx.js";

const acpManagerMocks = vi.hoisted(() => ({
  cancelSession: vi.fn(async (_params?: unknown) => {}),
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    markSessionAbortTarget: vi.fn(actual.markSessionAbortTarget),
    resolveSessionAbortTarget: vi.fn(actual.resolveSessionAbortTarget),
  };
});

vi.mock("../../acp/control-plane/manager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../acp/control-plane/manager.js")>()),
  getAcpSessionManager: () => ({
    cancelSession: acpManagerMocks.cancelSession,
  }),
}));

describe("abort handling", () => {
  const abortFixture = useChatAbortRegistryFixture();
  const trackedAbortMemoryKeys = new Set<string>();

  const operations = new Set<ReplyOperation>();

  function setTrackedAbortMemory(key: string, value: boolean) {
    trackedAbortMemoryKeys.add(key);
    setAbortMemory(key, value);
  }

  function readAbortSessionEntry(storePath: string, sessionKey: string) {
    return loadSessionEntry({ storePath, sessionKey });
  }

  async function createAbortConfig(params?: {
    commandsTextEnabled?: boolean;
    sessionIdsByKey?: Record<string, string>;
    nowMs?: number;
  }) {
    const root = abortFixture.stateDir;
    const storePath = path.join(root, "sessions.json");
    const cfg = {
      session: { store: storePath },
      ...(params?.commandsTextEnabled === undefined
        ? {}
        : { commands: { text: params.commandsTextEnabled } }),
    } as OpenClawConfig;
    if (params?.sessionIdsByKey) {
      for (const sessionKey of Object.keys(params.sessionIdsByKey)) {
        trackedAbortMemoryKeys.add(sessionKey);
      }
      await Promise.all(
        Object.entries(params.sessionIdsByKey).map(([sessionKey, sessionId]) =>
          replaceSessionEntry(
            { storePath, sessionKey },
            {
              sessionId,
              lifecycleRevision: `${sessionId}-revision`,
              updatedAt: params.nowMs ?? Date.now(),
            },
          ),
        ),
      );
    }
    return { root, storePath, cfg };
  }

  async function runStopCommand(params: {
    cfg: OpenClawConfig;
    sessionKey?: string;
    parentSessionKey?: string;
    from?: string;
    to?: string;
    senderId?: string;
    commandSource?: "native" | "text";
    targetSessionKey?: string;
    messageSid?: string;
    timestamp?: number;
    body?: string;
  }) {
    const from = params.from ?? "telegram:123";
    const to = params.to ?? from;
    for (const key of [
      params.sessionKey,
      params.parentSessionKey,
      params.targetSessionKey,
      from,
      to,
    ]) {
      if (key) {
        trackedAbortMemoryKeys.add(key);
      }
    }
    return tryFastAbortFromMessage({
      ctx: buildTestCtx({
        CommandBody: params.body ?? "/stop",
        RawBody: params.body ?? "/stop",
        CommandAuthorized: true,
        Provider: "telegram",
        Surface: "telegram",
        From: from,
        To: to,
        ...(params.sessionKey ? { SessionKey: params.sessionKey } : {}),
        ...(params.parentSessionKey ? { ParentSessionKey: params.parentSessionKey } : {}),
        ...(params.senderId ? { SenderId: params.senderId } : {}),
        ...(params.commandSource ? { CommandSource: params.commandSource } : {}),
        ...(params.targetSessionKey ? { CommandTargetSessionKey: params.targetSessionKey } : {}),
        ...(params.messageSid ? { MessageSid: params.messageSid } : {}),
        ...(typeof params.timestamp === "number" ? { Timestamp: params.timestamp } : {}),
      }),
      cfg: params.cfg,
    });
  }

  function enqueueQueuedFollowupRun(params: {
    root: string;
    cfg: OpenClawConfig;
    sessionId: string;
    sessionKey: string;
  }) {
    trackedAbortMemoryKeys.add(params.sessionKey);
    const followup = createQueueTestRun(
      { prompt: "queued" },
      {
        agentId: resolveSessionAgentId({ config: params.cfg, sessionKey: params.sessionKey }),
        agentDir: path.join(params.root, "agent"),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: path.join(params.root, "session.jsonl"),
        workspaceDir: path.join(params.root, "workspace"),
        config: params.cfg,
      },
    );
    enqueueFollowupRun(
      params.sessionKey,
      followup,
      { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
      "none",
    );
    return followup;
  }

  function createAbortOperation(cfg: OpenClawConfig, sessionKey: string, sessionId: string) {
    const agentId = resolveSessionAgentId({ config: cfg, sessionKey });
    const operation = createReplyOperation({
      agentId,
      sessionKey,
      sessionId,
      resetTriggered: false,
      target: captureSessionTarget({
        storeScope: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
        sessionKey,
        incarnation: sessionId,
        agentId,
      }),
    });
    operations.add(operation);
    return operation;
  }

  function createActiveAbortOperation(
    cfg: OpenClawConfig,
    sessionKey: string,
    sessionId: string,
    runId?: string,
  ) {
    const operation = createAbortOperation(cfg, sessionKey, sessionId);
    const cancel = vi.fn(() => queueMicrotask(() => operation.complete()));
    operation.attachBackend({ kind: "embedded", runId, cancel, isStreaming: () => true });
    return { operation, cancel };
  }

  function addChild(
    storePath: string,
    requesterSessionKey: string,
    childSessionKey: string,
    overrides: Partial<SubagentRunFixture> & Pick<SubagentRunFixture, "runId">,
  ) {
    return addSubagentFixture({
      childSessionKey,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ storePath, sessionKey: childSessionKey }),
      requesterSessionKey,
      requesterDisplayKey: requesterSessionKey,
      task: "stop child",
      cleanup: "keep",
      createdAt: Date.now(),
      ...overrides,
    });
  }

  function bindAcpSessionForTest(targetSessionKey: string) {
    vi.spyOn(getSessionBindingService(), "resolveByConversationAsync").mockImplementation(
      async (conversation) => ({
        bindingId: "test-acp-binding",
        targetKind: "session",
        targetSessionKey,
        conversation,
        status: "active",
        boundAt: 0,
      }),
    );
  }

  afterEach(async () => {
    for (const operation of operations) {
      operation.complete();
    }
    await Promise.all([...operations].map((operation) => operation.ownerSettlement));
    operations.clear();
    for (const key of trackedAbortMemoryKeys) {
      setAbortMemory(key, false);
      clearSessionQueues([key]);
    }
    trackedAbortMemoryKeys.clear();
    vi.restoreAllMocks();
    vi.mocked(markSessionAbortTarget).mockReset();
    vi.mocked(resolveSessionAbortTarget).mockReset();
    acpManagerMocks.cancelSession.mockReset().mockResolvedValue(undefined);
  });

  registerAbortDetectionCases(setTrackedAbortMemory);
  registerAbortAcpCases({
    createAbortConfig,
    createAbortOperation,
    createActiveAbortOperation,
    enqueueQueuedFollowupRun,
    runStopCommand,
    bindAcpSessionForTest,
    readAbortSessionEntry,
    acpManagerMocks,
  });

  it("fast-aborts authorized slash stop before queuing even with text commands disabled", async () => {
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    const activeSessionId = "session-active";
    const { root, cfg } = await createAbortConfig({
      commandsTextEnabled: false,
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    cfg.commands = {
      ...cfg.commands,
      ownerAllowFrom: ["telegram:123"],
    };
    const active = createActiveAbortOperation(cfg, sessionKey, activeSessionId);
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });

    expect(getFollowupQueueDepth(sessionKey)).toBe(1);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      senderId: "123",
      commandSource: "text",
    });

    expect(result.handled).toBe(true);
    expect(active.cancel).toHaveBeenCalledOnce();

    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
  });

  it("gives a bare stop word the channel-user queue, child, and hook policy", async () => {
    const sessionKey = "telegram:bare-stop";
    const sessionId = "session-bare-stop";
    const childKey = "agent:main:subagent:bare-stop-child";
    const childSessionId = "session-bare-stop-child";
    const { root, storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId, [childKey]: childSessionId },
    });
    cfg.commands = { ...cfg.commands, ownerAllowFrom: ["telegram:123"] };
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    await addChild(storePath, sessionKey, childKey, {
      runId: "bare-stop-child-run",
    });
    const hook = vi.fn();
    registerInternalHook("command:stop", hook);

    try {
      const result = await runStopCommand({
        cfg,
        sessionKey,
        senderId: "123",
        commandSource: "text",
        body: "stop",
      });

      expect(result).toMatchObject({ handled: true, stoppedSubagents: 1 });
      expect(getFollowupQueueDepth(sessionKey)).toBe(0);
      expect(await getSubagentRunByChildSessionKey(childKey)).toMatchObject({
        endedReason: "subagent-killed",
        killReconciliation: { suppressTaskDelivery: true },
      });
      expect(hook).toHaveBeenCalledOnce();
    } finally {
      unregisterInternalHook("command:stop", hook);
    }
  });

  it("fast-abort resolves canonical stored session identity before metadata persistence", async () => {
    const storeKey = "agent:main:telegram:group:-1001234567890:topic:99";
    const lookupKey = "Agent:Main:Telegram:Group:-1001234567890:Topic:99";
    const sessionId = "agent-topic-99";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [storeKey]: sessionId },
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey: storeKey });

    const result = await runStopCommand({
      cfg,
      sessionKey: lookupKey,
    });

    expect(result.handled).toBe(true);
    expect(getFollowupQueueDepth(storeKey)).toBe(0);
  });

  it.each([false, true])(
    "persists cutoff only for the command's own session (explicit target: %s)",
    async (explicit) => {
      const targetKey = explicit ? "agent:main:telegram:group:123" : "telegram:parent-only";
      const { storePath, cfg } = await createAbortConfig({
        sessionIdsByKey: { [targetKey]: "session-target" },
      });
      const messageSid = "56";
      const timestamp = 1234567890001;
      const result = await runStopCommand({
        cfg,
        ...(explicit
          ? { sessionKey: "telegram:slash:123", targetSessionKey: targetKey }
          : { parentSessionKey: targetKey, from: targetKey }),
        messageSid,
        timestamp,
      });

      expect(result.handled).toBe(true);
      const entry = readAbortSessionEntry(storePath, targetKey);
      expect(entry?.abortedLastRun).toBe(true);
      expect(entry?.abortCutoffMessageSid).toBe(explicit ? undefined : messageSid);
      expect(entry?.abortCutoffTimestamp).toBe(explicit ? undefined : timestamp);
    },
  );

  it.each(["active", "paused", "stale-parent", "reparented"] as const)(
    "stops only the current controlled subtree (%s)",
    async (scenario) => {
      const moved = scenario === "reparented";
      const paused = scenario === "paused";
      const stale = scenario === "stale-parent";
      const root = moved ? "agent:main:subagent:old-parent" : "telegram:parent";
      const other = "agent:main:subagent:new-parent";
      const child = "agent:main:subagent:child";
      const leaf = child + ":subagent:leaf";
      const now = Date.now();
      const { storePath, cfg } = await createAbortConfig({
        nowMs: now,
        sessionIdsByKey: Object.fromEntries(
          [root, other, child, leaf].map((key, index) => [key, `session-${index}`]),
        ),
      });
      const add = (
        runId: string,
        parent: string,
        key: string,
        overrides: Partial<SubagentRunFixture> = {},
      ) =>
        addChild(storePath, parent, key, {
          runId,
          createdAt: now - 2000,
          ...(moved ? { controllerSessionKey: parent } : {}),
          ...overrides,
        });
      await add("child-original", root, child, {
        ...(stale ? { startedAt: now - 1900 } : {}),
        ...(paused
          ? { createdAt: now - 1000, endedAt: now - 500, pauseReason: "sessions_yield" }
          : {}),
        ...(moved ? { endedAt: now - 1000, outcome: { status: "ok" } } : {}),
      });
      if (stale) {
        await add("child-current", root, child, {
          createdAt: now - 1000,
          startedAt: now - 900,
          endedAt: now - 500,
          outcome: { status: "ok" },
        });
      }
      if (!paused) {
        await add("leaf", child, leaf, { createdAt: now - 400 });
      }
      if (moved) {
        await add("child-reparented", other, child, { createdAt: now - 250 });
      }

      if (moved || paused) {
        expect(await stopSubagentsForRequester({ cfg, requesterSessionKey: root })).toEqual({
          stopped: moved ? 0 : 1,
          failed: 0,
        });
      } else {
        expect((await runStopCommand({ cfg, sessionKey: root, from: root })).stoppedSubagents).toBe(
          stale ? 1 : 2,
        );
      }
      const currentChild = await getSubagentRunByChildSessionKey(child);
      if (moved) {
        expect(currentChild?.execution.endedAt).toBeUndefined();
        expect((await getSubagentRunByChildSessionKey(leaf))?.execution.endedAt).toBeUndefined();
      } else if (paused) {
        expect(currentChild).toMatchObject({
          endedReason: "subagent-killed",
          killReconciliation: { suppressTaskDelivery: true },
        });
      } else if (stale) {
        expect(currentChild?.endedReason).not.toBe("subagent-killed");
        expect((await getSubagentRunByChildSessionKey(leaf))?.endedReason).toBe("subagent-killed");
      }
    },
  );

  it("resolves owner authorization after loading cancellation runtime", async () => {
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    cfg.commands = { ownerAllowFrom: ["telegram:123"] };
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    const pending = runStopCommand({
      cfg,
      sessionKey,
      senderId: "123",
    });
    cfg.commands.ownerAllowFrom = ["telegram:other-owner"];

    await expect(pending).resolves.toEqual({ handled: false, aborted: false });
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
  });

  it.each(["throws", "unpersisted"] as const)(
    "still stops the resolved target when metadata persistence %s",
    async (failure) => {
      const canonicalKey = "agent:main:telegram:group:-1001234567890:topic:99";
      const sessionKey = failure === "throws" ? "telegram:persistence-failure" : canonicalKey;
      const requestedKey =
        failure === "throws" ? sessionKey : "Agent:Main:Telegram:Group:-1001234567890:Topic:99";
      const sessionId = "persistence-failure-session";
      const { root, cfg } = await createAbortConfig({
        sessionIdsByKey: failure === "throws" ? { [sessionKey]: sessionId } : {},
      });
      const { operation } = createActiveAbortOperation(cfg, sessionKey, sessionId);
      if (failure === "throws") {
        vi.mocked(markSessionAbortTarget).mockRejectedValueOnce(
          new Error("simulated persistence failure"),
        );
      } else {
        const target = { entry: { sessionId, updatedAt: 10 }, sessionId, sessionKey };
        vi.mocked(resolveSessionAbortTarget).mockResolvedValueOnce(target);
        vi.mocked(markSessionAbortTarget).mockResolvedValueOnce({
          ...target,
          persisted: false,
          persistenceError: "simulated persistence failure",
        });
      }
      enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });

      expect((await runStopCommand({ cfg, sessionKey: requestedKey })).handled).toBe(true);
      expect(markSessionAbortTarget).toHaveBeenCalledOnce();
      expect(operation.abortSignal.aborted).toBe(true);
      expect(getFollowupQueueDepth(sessionKey)).toBe(0);
      expect(getAbortMemory(sessionKey)).toBeUndefined();
    },
  );

  it("fast-abort leaves future prompts untouched when no persisted target entry exists", async () => {
    const sessionKey = "telegram:missing-persistence-target";
    const { cfg } = await createAbortConfig();
    vi.mocked(markSessionAbortTarget).mockResolvedValueOnce(null);
    vi.mocked(resolveSessionAbortTarget).mockResolvedValueOnce(null);

    const result = await runStopCommand({
      cfg,
      sessionKey,
    });

    expect(result.handled).toBe(true);
    expect(getAbortMemory(sessionKey)).toBeUndefined();
  });

  it("fast-abort does not wait for abort metadata persistence before stopping runs", async () => {
    const sessionKey = "telegram:slow-persistence";
    const childKey = "agent:main:subagent:slow-persistence-child";
    const sessionId = "session-slow-persistence";
    const childSessionId = "session-slow-persistence-child";
    const { root, storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [childKey]: childSessionId,
        [sessionKey]: sessionId,
      },
    });
    const { operation, cancel } = createActiveAbortOperation(cfg, sessionKey, sessionId);
    const persistenceStarted = createDeferred();
    const persistence = createDeferred<SessionAbortTargetResult | null>();
    const target = { entry: { sessionId, updatedAt: 10 }, sessionId, sessionKey };
    vi.mocked(resolveSessionAbortTarget).mockResolvedValueOnce(target);
    vi.mocked(markSessionAbortTarget).mockImplementationOnce(() => {
      persistenceStarted.resolve();
      return persistence.promise;
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    await addChild(storePath, sessionKey, childKey, {
      runId: "slow-child-run",
    });

    const child = createActiveAbortOperation(cfg, childKey, childSessionId, "slow-child-run");
    const resultPromise = runStopCommand({
      cfg,
      sessionKey,
    });
    await persistenceStarted.promise;

    expect(operation.abortSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(child.operation.abortSignal.aborted).toBe(true);
    expect(child.cancel).toHaveBeenCalledOnce();
    expect(await getSubagentRunByChildSessionKey(childKey)).toMatchObject({
      endedReason: "subagent-killed",
      killReconciliation: { suppressTaskDelivery: true },
    });
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);

    persistence.resolve({ ...target, persisted: true });
    await expect(resultPromise).resolves.toMatchObject({
      aborted: true,
      handled: true,
    });
  });

  it("propagates a callback failure without a requester", async () => {
    const requesterSessionKey = undefined;

    const beforeKill = vi.fn(() => {
      throw new Error("parent cancellation failed");
    });
    await expect(
      stopSubagentsForRequester({ cfg: {}, requesterSessionKey, beforeKill }),
    ).rejects.toThrow("parent cancellation failed");
    expect(beforeKill).toHaveBeenCalledOnce();
  });

  it("does not report /stop success after the active backend freezes its outcome", async () => {
    const sessionKey = "agent:main:telegram:direct:finalizing";
    const sessionId = "session-finalizing";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    const cancel = vi.fn();
    const operation = createAbortOperation(cfg, sessionKey, sessionId);
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => false,
    });
    operation.setPhase("running");
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    const hook = vi.fn();
    registerInternalHook("command:stop", hook);
    onTestFinished(() => unregisterInternalHook("command:stop", hook));
    vi.mocked(markSessionAbortTarget).mockClear();

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:finalizing",
    });

    expect(result).toMatchObject({
      handled: true,
      aborted: false,
      rejectionReason: "finalizing",
    });
    expect(operation.result).toBeNull();
    expect(isSessionRunActiveForKey(sessionKey)).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expect(hook).toHaveBeenCalledOnce();
    expect(markSessionAbortTarget).not.toHaveBeenCalled();
    expect(getAbortMemory(sessionKey)).toBeUndefined();
    expect(formatAbortReplyText(undefined, result.rejectionReason)).toBe(
      "Agent reply is already finalizing and can no longer be aborted.",
    );
    expect(formatAbortReplyText(0, undefined, 1)).toBe(
      "⚙️ Agent was aborted. Cancellation was incomplete for 1 sub-agent. Retry /stop.",
    );
    operation.complete();
  });

  it.each([false, true])(
    "stops the explicit ACP target's source only when bound (bound=%s)",
    async (bound) => {
      const sourceSessionKey = "agent:main:discord:channel:C3";
      const acpSessionKey = "agent:codex:acp:explicit-target";
      const { cfg } = await createAbortConfig({
        sessionIdsByKey: {
          [sourceSessionKey]: "source-store-session",
          [acpSessionKey]: "acp-store-session",
        },
      });
      const { operation: sourceOperation } = createActiveAbortOperation(
        cfg,
        sourceSessionKey,
        "source-active-session",
      );
      if (bound) {
        bindAcpSessionForTest(acpSessionKey);
      }

      const result = await runStopCommand({
        cfg,
        ...(bound ? { parentSessionKey: sourceSessionKey } : { sessionKey: sourceSessionKey }),
        from: "discord:C3",
        targetSessionKey: acpSessionKey,
        commandSource: "native",
      });

      expect(result.handled).toBe(true);
      expect(sourceOperation.result).toEqual(
        bound ? { kind: "aborted", code: "aborted_by_user" } : null,
      );
      expect(isSessionRunActiveForKey(sourceSessionKey)).toBe(!bound);
      if (!bound) {
        expect(acpManagerMocks.cancelSession).not.toHaveBeenCalled();
      }
      sourceOperation.complete();
    },
  );

  it("continues stopping siblings when one termination persistence write fails", async () => {
    const sessionKey = "telegram:persistence-failure-parent";
    const firstChildKey = "agent:main:subagent:persistence-failure-first";
    const secondChildKey = "agent:main:subagent:persistence-failure-second";
    const { root, storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sessionKey]: "persistence-failure-parent",
        [firstChildKey]: "run-persistence-failure-first",
        [secondChildKey]: "run-persistence-failure-second",
      },
    });
    const createdAt = Date.now();
    for (const [runId, childKey] of [
      ["run-persistence-failure-first", firstChildKey],
      ["run-persistence-failure-second", secondChildKey],
    ] as const) {
      await addChild(storePath, sessionKey, childKey, {
        runId,
        createdAt,
      });
    }
    const children = [firstChildKey, secondChildKey].map((childSessionKey) => {
      const sessionId = loadSessionEntry({ storePath, sessionKey: childSessionKey })!.sessionId;
      const child = createActiveAbortOperation(cfg, childSessionKey, sessionId, sessionId);
      enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey: childSessionKey });
      return child;
    });
    let failedTombstone = false;
    probe.command(stateWorker, async (command, executeOptions, scope) => {
      if (isSubagentRegistryWriteCommand(command) && !failedTombstone) {
        const firstRow = command.input.values.find(
          (row) => row.run_id === "run-persistence-failure-first",
        );
        const first = firstRow && rowToSubagentRunRecord(firstRow);
        if (first?.execution.status === "terminal" && first.endedReason === "subagent-killed") {
          failedTombstone = true;
          throw new Error("sqlite busy");
        }
      }
      return scope.execute(command, executeOptions);
    });

    await expect(
      stopSubagentsForRequester({
        cfg,
        requesterSessionKey: sessionKey,
      }),
    ).resolves.toEqual({ stopped: 1, failed: 1 });
    expect(failedTombstone).toBe(true);
    for (const child of children) {
      expect(child.cancel).toHaveBeenCalledOnce();
      expect(child.operation.abortSignal.aborted).toBe(true);
    }
    expect(getFollowupQueueDepth(firstChildKey)).toBe(0);
    expect(getFollowupQueueDepth(secondChildKey)).toBe(0);
    expect((await getSubagentRunByChildSessionKey(firstChildKey))?.killIntent).toBeDefined();
    expect((await getSubagentRunByChildSessionKey(secondChildKey))?.endedReason).toBe(
      "subagent-killed",
    );
  });
});
