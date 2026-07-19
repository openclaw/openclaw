// Tests abort request handling, cutoff persistence, and active run cleanup.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  type SessionAbortTargetResult,
} from "../../config/sessions/session-accessor.js";
import type {
  AuthorizationInvocationContext,
  AuthorizationPolicyHandler,
  TurnAuthoritySnapshot,
} from "../../plugins/authorization-policy.types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  createOperatorTurnAuthoritySnapshot,
  createTurnAuthoritySnapshot,
} from "../../plugins/turn-authority.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { resolveAbortCutoffFromContext, shouldSkipMessageByAbortCutoff } from "./abort-cutoff.js";
import { getAbortMemory } from "./abort-primitives.js";
import {
  formatAbortReplyText,
  isAbortRequestText,
  isAbortTrigger,
  setAbortMemory,
  stopSubagentsForRequester,
  tryFastAbortFromMessage,
} from "./abort.js";
import { testing as abortTesting } from "./abort.test-support.js";
import { testing as acpResetTargetTesting } from "./acp-reset-target.test-support.js";
import { enqueueFollowupRun, getFollowupQueueDepth, type FollowupRun } from "./queue.js";
import { testing as queueCleanupTesting } from "./queue/cleanup.test-support.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { testing as replyRunRegistryTesting } from "./reply-run-registry.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

vi.mock("../../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(true),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

const commandQueueMocks = vi.hoisted(() => ({
  clearCommandLane: vi.fn(() => 1),
  clearCommandLaneByAuthorizationAffinity: vi.fn(() => 1),
}));

vi.mock("../../process/command-queue.js", () => commandQueueMocks);

const subagentRegistryMocks = vi.hoisted(() => ({
  listSubagentRunsForRequester: vi.fn<(requesterSessionKey: string) => SubagentRunRecord[]>(
    () => [],
  ),
  getLatestSubagentRunByChildSessionKey: vi.fn<
    (childSessionKey: string) => SubagentRunRecord | null
  >(() => null),
  markSubagentRunTerminated: vi.fn(() => 1),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey:
    subagentRegistryMocks.getLatestSubagentRunByChildSessionKey,
  listSubagentRunsForRequester: subagentRegistryMocks.listSubagentRunsForRequester,
  listSubagentRunsForController: subagentRegistryMocks.listSubagentRunsForRequester,
  markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
}));

const acpManagerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn<
    () =>
      | { kind: "none" }
      | {
          kind: "ready";
          sessionKey: string;
          meta: unknown;
        }
  >(() => ({ kind: "none" })),
  cancelSession: vi.fn(async () => {}),
}));

const runtimeAbortMocks = vi.hoisted(() => {
  const isCapturedIdentityCurrent = vi.fn(() => true);
  const abortEmbeddedAgentRun = vi.fn(() => true);
  return {
    abortEmbeddedAgentRun,
    captureActiveEmbeddedRunIdentity: vi.fn((sessionId: string) => ({
      sessionId,
      isCurrent: () => isCapturedIdentityCurrent(sessionId),
      abortIfCurrent: () => {
        if (!isCapturedIdentityCurrent(sessionId)) {
          return { status: "not_active" as const, replacementObserved: true };
        }
        return abortEmbeddedAgentRun(sessionId)
          ? { status: "aborted" as const, replacementObserved: false }
          : { status: "not_abortable" as const, replacementObserved: false };
      },
    })),
    isCapturedIdentityCurrent,
    resolveActiveEmbeddedRunSessionId: vi.fn(() => undefined as string | undefined),
  };
});

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: acpManagerMocks.resolveSession,
    cancelSession: acpManagerMocks.cancelSession,
  }),
}));

const suiteTempDirs = createSuiteTempRootTracker({ prefix: "openclaw-abort-" });

describe("abort detection", () => {
  const trackedAbortMemoryKeys = new Set<string>();

  function setTrackedAbortMemory(key: string, value: boolean): void {
    trackedAbortMemoryKeys.add(key);
    setAbortMemory(key, value);
  }

  beforeAll(async () => {
    await suiteTempDirs.setup();
  });

  afterAll(async () => {
    await suiteTempDirs.cleanup();
  });

  async function writeSessionStore(
    storePath: string,
    sessionIdsByKey: Record<string, string>,
    nowMs = Date.now(),
  ) {
    await Promise.all(
      Object.entries(sessionIdsByKey).map(([sessionKey, sessionId]) =>
        replaceSessionEntry({ storePath, sessionKey }, { sessionId, updatedAt: nowMs }),
      ),
    );
  }

  function readAbortSessionEntry(storePath: string, sessionKey: string) {
    return loadSessionEntry({ storePath, sessionKey });
  }

  async function createAbortConfig(params?: {
    commandsTextEnabled?: boolean;
    sessionIdsByKey?: Record<string, string>;
    nowMs?: number;
  }) {
    const root = await suiteTempDirs.make("case");
    const storePath = path.join(root, "sessions.json");
    const cfg = {
      session: { store: storePath },
      ...(typeof params?.commandsTextEnabled === "boolean"
        ? { commands: { text: params.commandsTextEnabled } }
        : {}),
    } as OpenClawConfig;
    if (params?.sessionIdsByKey) {
      for (const sessionKey of Object.keys(params.sessionIdsByKey)) {
        trackedAbortMemoryKeys.add(sessionKey);
      }
      await writeSessionStore(storePath, params.sessionIdsByKey, params.nowMs);
    }
    return { root, storePath, cfg };
  }

  async function runStopCommand(params: {
    cfg: OpenClawConfig;
    provider?: string;
    sessionKey?: string;
    parentSessionKey?: string;
    from: string;
    to: string;
    senderId?: string;
    commandSource?: "native" | "text";
    targetSessionKey?: string;
    messageSid?: string;
    timestamp?: number;
    body?: string;
    nativeChannelId?: string;
    threadParentId?: string;
    messageThreadId?: string;
    transportThreadId?: string;
    gatewayClientScopes?: string[];
    turnAuthority?: TurnAuthoritySnapshot;
  }) {
    for (const key of [
      params.sessionKey,
      params.parentSessionKey,
      params.targetSessionKey,
      params.from,
      params.to,
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
        Provider: params.provider ?? "telegram",
        Surface: params.provider ?? "telegram",
        From: params.from,
        To: params.to,
        ...(params.sessionKey ? { SessionKey: params.sessionKey } : {}),
        ...(params.parentSessionKey ? { ParentSessionKey: params.parentSessionKey } : {}),
        ...(params.senderId ? { SenderId: params.senderId } : {}),
        ...(params.commandSource ? { CommandSource: params.commandSource } : {}),
        ...(params.targetSessionKey ? { CommandTargetSessionKey: params.targetSessionKey } : {}),
        ...(params.messageSid ? { MessageSid: params.messageSid } : {}),
        ...(params.nativeChannelId ? { NativeChannelId: params.nativeChannelId } : {}),
        ...(params.threadParentId ? { ThreadParentId: params.threadParentId } : {}),
        ...(params.messageThreadId ? { MessageThreadId: params.messageThreadId } : {}),
        ...(params.transportThreadId ? { TransportThreadId: params.transportThreadId } : {}),
        ...(params.gatewayClientScopes ? { GatewayClientScopes: params.gatewayClientScopes } : {}),
        ...(params.turnAuthority ? { TurnAuthority: params.turnAuthority } : {}),
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
    const followupRun: FollowupRun = {
      prompt: "queued",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: path.join(params.root, "agent"),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        messageProvider: "telegram",
        agentAccountId: "acct",
        sessionFile: path.join(params.root, "session.jsonl"),
        workspaceDir: path.join(params.root, "workspace"),
        config: params.cfg,
        provider: "anthropic",
        model: "claude-opus-4-6",
        timeoutMs: 1000,
        blockReplyBreak: "text_end",
      },
    };
    enqueueFollowupRun(
      params.sessionKey,
      followupRun,
      { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
      "none",
    );
  }

  function expectSessionLaneCleared(sessionKey: string) {
    expect(commandQueueMocks.clearCommandLane).toHaveBeenCalledWith(`session:${sessionKey}`);
  }

  function setAbortTestDeps(
    deps: NonNullable<Parameters<typeof abortTesting.setDepsForTests>[0]> = {},
  ): void {
    abortTesting.setDepsForTests({
      getAcpSessionManager: (() =>
        ({
          resolveSession: acpManagerMocks.resolveSession,
          cancelSession: acpManagerMocks.cancelSession,
        }) as never) as never,
      abortEmbeddedAgentRun: runtimeAbortMocks.abortEmbeddedAgentRun,
      captureActiveEmbeddedRunIdentity: runtimeAbortMocks.captureActiveEmbeddedRunIdentity,
      resolveActiveEmbeddedRunSessionId: runtimeAbortMocks.resolveActiveEmbeddedRunSessionId,
      getLatestSubagentRunByChildSessionKey:
        subagentRegistryMocks.getLatestSubagentRunByChildSessionKey,
      listSubagentRunsForController: subagentRegistryMocks.listSubagentRunsForRequester,
      markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
      ...deps,
    });
  }

  beforeEach(() => {
    resetGlobalHookRunner();
    setAbortTestDeps();
    queueCleanupTesting.setDepsForTests({
      resolveEmbeddedSessionLane: (key) => `session:${key.trim() || "main"}`,
      clearCommandLane: commandQueueMocks.clearCommandLane,
      clearCommandLaneByAuthorizationAffinity:
        commandQueueMocks.clearCommandLaneByAuthorizationAffinity,
    });
    commandQueueMocks.clearCommandLane.mockClear().mockReturnValue(1);
    commandQueueMocks.clearCommandLaneByAuthorizationAffinity.mockClear().mockReturnValue(1);
    subagentRegistryMocks.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
    subagentRegistryMocks.markSubagentRunTerminated.mockReset().mockReturnValue(1);
  });

  afterEach(() => {
    for (const key of trackedAbortMemoryKeys) {
      setAbortMemory(key, false);
    }
    trackedAbortMemoryKeys.clear();
    abortTesting.resetDepsForTests();
    acpResetTargetTesting.setDepsForTest();
    queueCleanupTesting.resetDepsForTests();
    replyRunRegistryTesting.resetReplyRunRegistry();
    commandQueueMocks.clearCommandLane.mockClear().mockReturnValue(1);
    commandQueueMocks.clearCommandLaneByAuthorizationAffinity.mockClear().mockReturnValue(1);
    acpManagerMocks.resolveSession.mockReset().mockReturnValue({ kind: "none" });
    acpManagerMocks.cancelSession.mockReset().mockResolvedValue(undefined);
    runtimeAbortMocks.abortEmbeddedAgentRun.mockReset().mockReturnValue(true);
    runtimeAbortMocks.captureActiveEmbeddedRunIdentity.mockClear();
    runtimeAbortMocks.isCapturedIdentityCurrent.mockReset().mockReturnValue(true);
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReset().mockReturnValue(undefined);
    subagentRegistryMocks.getLatestSubagentRunByChildSessionKey.mockReset().mockReturnValue(null);
    resetGlobalHookRunner();
  });

  it("isAbortTrigger matches standalone abort trigger phrases", () => {
    const positives = [
      "stop",
      "esc",
      "abort",
      "exit",
      "interrupt",
      "stop openclaw",
      "openclaw stop",
      "stop action",
      "stop current action",
      "stop run",
      "stop current run",
      "stop agent",
      "stop the agent",
      "stop don't do anything",
      "stop dont do anything",
      "stop do not do anything",
      "stop doing anything",
      "do not do that",
      "please stop",
      "stop please",
      "STOP OPENCLAW",
      "stop openclaw!!!",
      "stop don’t do anything",
      "detente",
      "detén",
      "arrête",
      "停止",
      "停下来",
      "暂停",
      "停下来！",
      "やめて",
      "止めて",
      "रुको",
      "توقف",
      "стоп",
      "остановись",
      "останови",
      "остановить",
      "прекрати",
      "halt",
      "anhalten",
      "aufhören",
      "hoer auf",
      "stopp",
      "pare",
    ];
    for (const candidate of positives) {
      expect(isAbortTrigger(candidate)).toBe(true);
    }

    expect(isAbortTrigger("hello")).toBe(false);
    expect(isAbortTrigger("wait")).toBe(false);
    expect(isAbortTrigger("please wait")).toBe(false);
    expect(isAbortTrigger("please do not do that")).toBe(false);
    // /stop is NOT matched by isAbortTrigger - it's handled separately.
    expect(isAbortTrigger("/stop")).toBe(false);
  });

  it("isAbortRequestText aligns abort command semantics", () => {
    expect(isAbortRequestText("/stop")).toBe(true);
    expect(isAbortRequestText("/STOP")).toBe(true);
    expect(isAbortRequestText("/stop!!!")).toBe(true);
    expect(isAbortRequestText("/Stop!!!")).toBe(true);
    expect(isAbortRequestText("stop")).toBe(true);
    expect(isAbortRequestText("Stop")).toBe(true);
    expect(isAbortRequestText("STOP")).toBe(true);
    expect(isAbortRequestText("stop action")).toBe(true);
    expect(isAbortRequestText("stop openclaw!!!")).toBe(true);
    expect(isAbortRequestText("停下来")).toBe(true);
    expect(isAbortRequestText("暂停")).toBe(true);
    expect(isAbortRequestText("やめて")).toBe(true);
    expect(isAbortRequestText("остановись")).toBe(true);
    expect(isAbortRequestText("halt")).toBe(true);
    expect(isAbortRequestText("stopp")).toBe(true);
    expect(isAbortRequestText("pare")).toBe(true);
    expect(isAbortRequestText(" توقف ")).toBe(true);
    expect(isAbortRequestText("/stop@openclaw_bot", { botUsername: "openclaw_bot" })).toBe(true);
    expect(isAbortRequestText("/Stop@openclaw_bot", { botUsername: "openclaw_bot" })).toBe(true);

    expect(isAbortRequestText("/status")).toBe(false);
    expect(isAbortRequestText("wait")).toBe(false);
    expect(isAbortRequestText("please wait")).toBe(false);
    expect(isAbortRequestText("do not do that")).toBe(true);
    expect(isAbortRequestText("please do not do that")).toBe(false);
    expect(isAbortRequestText("/abort")).toBe(false);
  });

  it("removes abort memory entry when flag is reset", () => {
    setTrackedAbortMemory("session-1", true);
    expect(getAbortMemory("session-1")).toBe(true);

    setTrackedAbortMemory("session-1", false);
    expect(getAbortMemory("session-1")).toBeUndefined();
  });

  it("caps abort memory tracking to a bounded max size", () => {
    for (let i = 0; i < 2105; i += 1) {
      setTrackedAbortMemory(`bounded-memory-session-${i}`, true);
    }
    expect(getAbortMemory("bounded-memory-session-0")).toBeUndefined();
    expect(getAbortMemory("bounded-memory-session-2104")).toBe(true);
  });

  it("extracts abort cutoff metadata from context", () => {
    expect(
      resolveAbortCutoffFromContext(
        buildTestCtx({
          MessageSid: "42",
          Timestamp: 123,
        }),
      ),
    ).toEqual({
      messageSid: "42",
      timestamp: 123,
    });
  });

  it("treats numeric message IDs at or before cutoff as stale", () => {
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "199",
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "200",
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "201",
      }),
    ).toBe(false);
  });

  it("falls back to timestamp cutoff when message IDs are unavailable", () => {
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 1999,
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 2000,
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 2001,
      }),
    ).toBe(false);
  });

  it("fast-aborts even when text commands are disabled", async () => {
    const { cfg } = await createAbortConfig({ commandsTextEnabled: false });

    const result = await runStopCommand({
      cfg,
      sessionKey: "telegram:123",
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
  });

  it("fast-aborts authorized text slash stop commands before they queue", async () => {
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    const activeSessionId = "session-active";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    cfg.commands = {
      ...cfg.commands,
      ownerAllowFrom: ["telegram:123"],
    };
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(activeSessionId);
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
      senderId: "123",
      commandSource: "text",
      body: "stop",
    });

    expect(result.handled).toBe(true);
    expect(runtimeAbortMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(sessionKey);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(activeSessionId);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);
  });

  it("does not abort or mutate session state when policy denies fast /stop", async () => {
    const sessionKey = "telegram:policy-denied-stop";
    const sessionId = "session-policy-denied-stop";
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
      nowMs: 123,
    });
    const before = readAbortSessionEntry(storePath, sessionKey);
    const policy = vi.fn<AuthorizationPolicyHandler<"command.invoke">>((request) =>
      request.commandName === "stop"
        ? ({ effect: "deny", code: "stop-denied" } as const)
        : ({ effect: "pass" } as const),
    );
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "/plugins/sender-access/index.ts",
      policy: {
        id: "maintainer-actions",
        description: "Protect destructive commands",
        handlers: { "command.invoke": policy },
      },
    });
    initializeGlobalHookRunner(registry);
    const markSessionAbortTarget = vi.fn();
    setAbortTestDeps({ markSessionAbortTarget });
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("active-policy-denied");

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:policy-denied-stop",
      to: "telegram:policy-denied-stop",
      senderId: "policy-denied-stop",
      commandSource: "text",
      body: "stop",
      nativeChannelId: "thread-native",
      threadParentId: "maintenance-native",
      messageThreadId: "thread-native",
    });

    expect(result).toEqual({
      handled: true,
      aborted: false,
      rejectionReason: "policy-denied",
    });
    expect(formatAbortReplyText(undefined, result.rejectionReason)).toBe(
      "Command blocked by authorization policy.",
    );
    expect(policy).toHaveBeenCalledOnce();
    expect(policy.mock.calls[0]?.[1]).toMatchObject({
      sessionKey,
      sessionId: "active-policy-denied",
      conversationId: "thread-native",
      parentConversationId: "maintenance-native",
      threadId: "thread-native",
    });
    expect(runtimeAbortMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(sessionKey);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(markSessionAbortTarget).not.toHaveBeenCalled();
    expect(subagentRegistryMocks.listSubagentRunsForRequester).not.toHaveBeenCalled();
    expect(commandQueueMocks.clearCommandLane).not.toHaveBeenCalled();
    expect(readAbortSessionEntry(storePath, sessionKey)).toEqual(before);
  });

  it("does not abort a replacement that appears while fast /stop policy awaits", async () => {
    const sessionKey = "telegram:stop-target-replaced";
    const originalSessionId = "session-stop-original";
    const replacementSessionId = "session-stop-replacement";
    const originalRunId = "run-stop-original";
    const replacementRunId = "run-stop-replacement";
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: originalSessionId },
      nowMs: 123,
    });
    let activeRunId = originalRunId;
    const abortRun = vi.fn(() => true);
    const policyStarted = Promise.withResolvers<void>();
    const releasePolicy = Promise.withResolvers<void>();
    const policy = vi.fn<AuthorizationPolicyHandler<"command.invoke">>(async () => {
      policyStarted.resolve();
      await releasePolicy.promise;
      return { effect: "pass" };
    });
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "test",
      policy: {
        id: "stop-target-replacement",
        description: "Wait while the authorized stop target changes",
        handlers: { "command.invoke": policy },
      },
    });
    initializeGlobalHookRunner(registry);
    const markSessionAbortTarget = vi.fn();
    setAbortTestDeps({
      abortEmbeddedAgentRun: abortRun,
      captureActiveEmbeddedRunIdentity: (sessionId) => {
        const capturedRunId = activeRunId;
        return {
          sessionId,
          isCurrent: () => activeRunId === capturedRunId,
          abortIfCurrent: () =>
            activeRunId === capturedRunId
              ? abortRun(sessionId)
                ? { status: "aborted", replacementObserved: false }
                : { status: "not_abortable", replacementObserved: false }
              : { status: "not_active", replacementObserved: true },
        };
      },
      resolveActiveEmbeddedRunSessionId: () => activeRunId,
      markSessionAbortTarget,
    });

    const resultPromise = runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:stop-target-replaced",
      to: "telegram:stop-target-replaced",
    });
    await policyStarted.promise;
    activeRunId = replacementRunId;
    await replaceSessionEntry(
      { storePath, sessionKey },
      { sessionId: replacementSessionId, updatedAt: 456 },
    );
    releasePolicy.resolve();

    await expect(resultPromise).resolves.toEqual({
      handled: true,
      aborted: false,
      rejectionReason: "finalizing",
    });
    expect(policy).toHaveBeenCalledWith(
      expect.objectContaining({ commandName: "stop" }),
      expect.objectContaining({ sessionId: originalRunId }),
      expect.any(AbortSignal),
    );
    expect(abortRun).not.toHaveBeenCalled();
    expect(markSessionAbortTarget).not.toHaveBeenCalled();
    expect(commandQueueMocks.clearCommandLane).not.toHaveBeenCalled();
    expect(readAbortSessionEntry(storePath, sessionKey)).toMatchObject({
      sessionId: replacementSessionId,
    });
  });

  it("uses the captured run CAS when replacement lands after pre-effect revalidation", async () => {
    const sessionKey = "telegram:stop-run-cas";
    const sessionId = "session-stop-run-cas";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    let generation = "original";
    let identityChecks = 0;
    const abortRun = vi.fn(() => true);
    const markSessionAbortTarget = vi.fn();
    setAbortTestDeps({
      abortEmbeddedAgentRun: abortRun,
      captureActiveEmbeddedRunIdentity: (capturedSessionId) => {
        const capturedGeneration = generation;
        return {
          sessionId: capturedSessionId,
          isCurrent: () => {
            const current = generation === capturedGeneration;
            identityChecks += 1;
            if (identityChecks === 1) {
              generation = "replacement";
            }
            return current;
          },
          abortIfCurrent: () =>
            generation === capturedGeneration
              ? abortRun(capturedSessionId)
                ? { status: "aborted", replacementObserved: false }
                : { status: "not_abortable", replacementObserved: false }
              : { status: "not_active", replacementObserved: true },
        };
      },
      resolveActiveEmbeddedRunSessionId: () => sessionId,
      markSessionAbortTarget,
    });

    await expect(
      runStopCommand({
        cfg,
        sessionKey,
        from: "telegram:stop-run-cas",
        to: "telegram:stop-run-cas",
      }),
    ).resolves.toEqual({
      handled: true,
      aborted: false,
      rejectionReason: "finalizing",
    });
    expect(generation).toBe("replacement");
    expect(abortRun).not.toHaveBeenCalled();
    expect(markSessionAbortTarget).not.toHaveBeenCalled();
    expect(commandQueueMocks.clearCommandLane).not.toHaveBeenCalled();
  });

  it("denies Slack transport-thread /stop before any abort mutation", async () => {
    const sessionKey = "agent:main:slack:channel:CMAINTENANCE";
    const sessionId = "session-slack-transport-stop";
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
      nowMs: 123,
    });
    const before = readAbortSessionEntry(storePath, sessionKey);
    const policy = vi.fn<AuthorizationPolicyHandler<"command.invoke">>((request, context) =>
      request.commandName === "stop" &&
      context.principal.kind === "sender" &&
      context.principal.provider === "slack" &&
      context.threadId === "1712345678.000100"
        ? { effect: "deny", code: "thread-stop-denied" }
        : { effect: "pass" },
    );
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "test",
      policy: {
        id: "thread-access",
        description: "Protect Slack thread stop commands",
        handlers: { "command.invoke": policy },
      },
    });
    initializeGlobalHookRunner(registry);
    const markSessionAbortTarget = vi.fn();
    setAbortTestDeps({ markSessionAbortTarget });
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(sessionId);

    const result = await runStopCommand({
      cfg,
      provider: "slack",
      sessionKey,
      from: "slack:channel:CMAINTENANCE",
      to: "slack:channel:CMAINTENANCE",
      senderId: "U-MAINTAINER",
      commandSource: "text",
      nativeChannelId: "CMAINTENANCE",
      threadParentId: "CMAINTENANCE",
      transportThreadId: "1712345678.000100",
    });

    expect(result).toEqual({
      handled: true,
      aborted: false,
      rejectionReason: "policy-denied",
    });
    expect(policy).toHaveBeenCalledWith(
      expect.objectContaining({ commandName: "stop" }),
      expect.objectContaining({ threadId: "1712345678.000100" }),
      expect.any(AbortSignal),
    );
    expect(runtimeAbortMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(
      sessionKey.toLowerCase(),
    );
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(markSessionAbortTarget).not.toHaveBeenCalled();
    expect(commandQueueMocks.clearCommandLane).not.toHaveBeenCalled();
    expect(commandQueueMocks.clearCommandLaneByAuthorizationAffinity).not.toHaveBeenCalled();
    expect(readAbortSessionEntry(storePath, sessionKey)).toEqual(before);
  });

  it("rebinds issued turn authority to command before fast /stop authorization", async () => {
    const sessionKey = "agent:main:telegram:direct:command-trigger-stop";
    const sessionId = "session-command-trigger-stop";
    const { root, storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
      nowMs: 123,
    });
    const before = readAbortSessionEntry(storePath, sessionKey);
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(
      "active-command-trigger-stop",
    );
    const markSessionAbortTarget = vi.fn();
    setAbortTestDeps({ markSessionAbortTarget });
    const policy = vi.fn<AuthorizationPolicyHandler<"command.invoke">>((request, context) =>
      request.commandName === "stop" && context.trigger === "command"
        ? { effect: "deny", code: "command-trigger-denied" }
        : { effect: "pass" },
    );
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "test",
      policy: {
        id: "command-trigger-access",
        description: "Deny command-triggered stop",
        handlers: { "command.invoke": policy },
      },
    });
    initializeGlobalHookRunner(registry);
    const authority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "telegram",
        senderId: "command-trigger-stop",
        senderIsOwner: true,
        isAuthorizedSender: true,
      },
      agentId: "main",
      sessionKey,
      sessionId,
      conversationId: "trusted-thread",
      trigger: "gateway",
    });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:command-trigger-stop",
      to: "telegram:command-trigger-stop",
      senderId: "command-trigger-stop",
      turnAuthority: authority,
    });

    expect(result).toEqual({
      handled: true,
      aborted: false,
      rejectionReason: "policy-denied",
    });
    expect(policy).toHaveBeenCalledOnce();
    expect(policy.mock.calls[0]?.[1]).toMatchObject({
      agentId: "main",
      sessionKey,
      sessionId: "active-command-trigger-stop",
      conversationId: "trusted-thread",
      trigger: "command",
    });
    expect(runtimeAbortMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(sessionKey);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(markSessionAbortTarget).not.toHaveBeenCalled();
    expect(commandQueueMocks.clearCommandLane).not.toHaveBeenCalled();
    expect(commandQueueMocks.clearCommandLaneByAuthorizationAffinity).not.toHaveBeenCalled();
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
    expect(readAbortSessionEntry(storePath, sessionKey)).toEqual(before);
  });

  it("rejects cloned turn authority before fast /stop mutates runtime state", async () => {
    const sessionKey = "agent:main:telegram:direct:forged-stop";
    const sessionId = "session-forged-stop";
    const { root, storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
      nowMs: 123,
    });
    const before = readAbortSessionEntry(storePath, sessionKey);
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("active-forged-stop");
    const markSessionAbortTarget = vi.fn();
    setAbortTestDeps({ markSessionAbortTarget });
    const policy = vi.fn<AuthorizationPolicyHandler<"command.invoke">>(() => ({
      effect: "pass",
    }));
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "/plugins/sender-access/index.ts",
      policy: {
        id: "maintainer-actions",
        description: "Protect destructive commands",
        handlers: { "command.invoke": policy },
      },
    });
    initializeGlobalHookRunner(registry);
    const authority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "telegram",
        senderId: "forged-stop",
        senderIsOwner: true,
        isAuthorizedSender: true,
      },
      agentId: "main",
      sessionKey,
      sessionId,
      conversationId: "forged-stop",
      trigger: "command",
    });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:forged-stop",
      to: "telegram:forged-stop",
      senderId: "forged-stop",
      turnAuthority: structuredClone(authority),
    });

    expect(result).toEqual({
      handled: true,
      aborted: false,
      rejectionReason: "policy-denied",
    });
    expect(policy).not.toHaveBeenCalled();
    expect(runtimeAbortMocks.resolveActiveEmbeddedRunSessionId).not.toHaveBeenCalled();
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
    expect(markSessionAbortTarget).not.toHaveBeenCalled();
    expect(commandQueueMocks.clearCommandLane).not.toHaveBeenCalled();
    expect(commandQueueMocks.clearCommandLaneByAuthorizationAffinity).not.toHaveBeenCalled();
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
    expect(readAbortSessionEntry(storePath, sessionKey)).toEqual(before);
  });

  it("uses immutable operator authority despite client-derived sender fields and rebinds /stop scope", async () => {
    const seen: AuthorizationInvocationContext[] = [];
    const policy = vi.fn<AuthorizationPolicyHandler<"command.invoke">>((request, context) => {
      seen.push(context);
      if (
        request.commandName === "stop" &&
        context.principal.kind === "operator" &&
        context.principal.scopes.includes("operator.admin")
      ) {
        return { effect: "pass" };
      }
      return { effect: "deny", code: "admin-required" };
    });
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "operator-access",
      source: "test",
      policy: {
        id: "operator-access",
        description: "Require admin operator authority for stop",
        handlers: { "command.invoke": policy },
      },
    });
    initializeGlobalHookRunner(registry);

    const adminKey = "agent:main:telegram:direct:gateway-admin";
    const adminSessionId = "gateway-admin-session";
    const { cfg: adminCfg } = await createAbortConfig({
      sessionIdsByKey: { [adminKey]: adminSessionId },
    });
    adminCfg.commands = { ownerAllowFrom: ["telegram:client-info-owner"] };
    const adminAuthority = createOperatorTurnAuthoritySnapshot({
      scopes: ["operator.admin"],
      pairedClientId: "paired-admin",
      connectionId: "admin-connection",
      isOwner: true,
      agentId: "stale-agent",
      sessionKey: "agent:stale:main",
      sessionId: "stale-session",
      runId: "gateway-admin-run",
      conversationId: "trusted-thread",
      parentConversationId: "trusted-maintenance",
      threadId: "trusted-thread",
      trigger: "gateway",
    });

    await expect(
      runStopCommand({
        cfg: adminCfg,
        sessionKey: adminKey,
        from: "telegram:client-info-owner",
        to: "telegram:forged-target",
        senderId: "client-info-owner",
        nativeChannelId: "forged-thread",
        threadParentId: "forged-maintenance",
        messageThreadId: "forged-thread",
        gatewayClientScopes: ["operator.write"],
        turnAuthority: adminAuthority,
      }),
    ).resolves.toMatchObject({ handled: true, aborted: true });

    const writeKey = "agent:main:telegram:direct:gateway-write";
    const writeSessionId = "gateway-write-session";
    const { cfg: writeCfg } = await createAbortConfig({
      sessionIdsByKey: { [writeKey]: writeSessionId },
      nowMs: 123,
    });
    writeCfg.commands = { ownerAllowFrom: ["telegram:client-info-owner"] };
    const writeAuthority = createOperatorTurnAuthoritySnapshot({
      scopes: ["operator.write"],
      pairedClientId: "paired-write",
      connectionId: "write-connection",
      isOwner: false,
      agentId: "stale-agent",
      sessionKey: "agent:stale:main",
      sessionId: "stale-session",
      runId: "gateway-write-run",
      conversationId: "trusted-thread",
      parentConversationId: "trusted-maintenance",
      threadId: "trusted-thread",
      trigger: "gateway",
    });

    await expect(
      runStopCommand({
        cfg: writeCfg,
        sessionKey: writeKey,
        from: "telegram:client-info-owner",
        to: "telegram:forged-target",
        senderId: "client-info-owner",
        nativeChannelId: "forged-thread",
        threadParentId: "forged-maintenance",
        messageThreadId: "forged-thread",
        gatewayClientScopes: ["operator.admin"],
        turnAuthority: writeAuthority,
      }),
    ).resolves.toEqual({
      handled: true,
      aborted: false,
      rejectionReason: "policy-denied",
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      principal: {
        kind: "operator",
        scopes: ["operator.admin"],
        clientId: "paired-admin",
        isOwner: true,
      },
      agentId: "main",
      sessionKey: adminKey,
      sessionId: adminSessionId,
      runId: "gateway-admin-run",
      conversationId: "trusted-thread",
      parentConversationId: "trusted-maintenance",
      threadId: "trusted-thread",
      trigger: "command",
    });
    expect(seen[1]).toEqual({
      principal: {
        kind: "operator",
        scopes: ["operator.write"],
        clientId: "paired-write",
        isOwner: false,
      },
      agentId: "main",
      sessionKey: writeKey,
      sessionId: writeSessionId,
      runId: "gateway-write-run",
      conversationId: "trusted-thread",
      parentConversationId: "trusted-maintenance",
      threadId: "trusted-thread",
      trigger: "command",
    });
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(adminSessionId);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).not.toHaveBeenCalledWith(writeSessionId);
  });

  it("keeps authenticated external sender authorization when no turn snapshot exists", async () => {
    const sessionKey = "agent:main:telegram:direct:external-maintainer";
    const sessionId = "external-maintainer-session";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    const policy = vi.fn<AuthorizationPolicyHandler<"command.invoke">>((request, context) =>
      request.commandName === "stop" &&
      context.principal.kind === "sender" &&
      context.principal.senderId === "external-maintainer" &&
      context.principal.isAuthorizedSender === true
        ? { effect: "pass" }
        : { effect: "deny", code: "sender-required" },
    );
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "sender-access",
      source: "test",
      policy: {
        id: "sender-access",
        description: "Allow the authenticated external sender",
        handlers: { "command.invoke": policy },
      },
    });
    initializeGlobalHookRunner(registry);

    await expect(
      runStopCommand({
        cfg,
        sessionKey,
        from: "telegram:external-maintainer",
        to: "telegram:maintenance",
        senderId: "external-maintainer",
        nativeChannelId: "maintenance-thread",
        threadParentId: "maintenance",
        messageThreadId: "maintenance-thread",
      }),
    ).resolves.toMatchObject({ handled: true, aborted: true });

    expect(policy).toHaveBeenCalledOnce();
    expect(policy.mock.calls[0]?.[1]).toMatchObject({
      principal: {
        kind: "sender",
        provider: "telegram",
        senderId: "external-maintainer",
        senderIsOwner: false,
        isAuthorizedSender: true,
      },
      agentId: "main",
      sessionKey,
      sessionId,
      conversationId: "maintenance-thread",
      parentConversationId: "maintenance",
      threadId: "maintenance-thread",
      trigger: "command",
    });
  });

  it("fast-abort clears queued followups and session lane", async () => {
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);
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
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(sessionId);
    expect(getFollowupQueueDepth(storeKey)).toBe(0);
    expectSessionLaneCleared(storeKey);
  });

  it("fast-abort still stops active runs when abort metadata persistence fails", async () => {
    const sessionKey = "telegram:persistence-failure";
    const sessionId = "session-persistence-failure";
    const activeSessionId = "active-persistence-failure";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(activeSessionId);
    setAbortTestDeps({
      getAcpSessionManager: (() =>
        ({
          resolveSession: acpManagerMocks.resolveSession,
          cancelSession: acpManagerMocks.cancelSession,
        }) as never) as never,
      abortEmbeddedAgentRun: runtimeAbortMocks.abortEmbeddedAgentRun,
      resolveActiveEmbeddedRunSessionId: runtimeAbortMocks.resolveActiveEmbeddedRunSessionId,
      markSessionAbortTarget: vi.fn(async () => {
        throw new Error("simulated persistence failure");
      }),
      getLatestSubagentRunByChildSessionKey:
        subagentRegistryMocks.getLatestSubagentRunByChildSessionKey,
      listSubagentRunsForController: subagentRegistryMocks.listSubagentRunsForRequester,
      markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(activeSessionId);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);
    expect(getAbortMemory(sessionKey)).toBeUndefined();
  });

  it("fast-abort uses resolved target identity when abort metadata save fails", async () => {
    const requestedKey = "Agent:Main:Telegram:Group:-1001234567890:Topic:99";
    const canonicalKey = "agent:main:telegram:group:-1001234567890:topic:99";
    const sessionId = "resolved-persistence-failure";
    const { root, cfg } = await createAbortConfig();
    setAbortTestDeps({
      getAcpSessionManager: (() =>
        ({
          resolveSession: acpManagerMocks.resolveSession,
          cancelSession: acpManagerMocks.cancelSession,
        }) as never) as never,
      abortEmbeddedAgentRun: runtimeAbortMocks.abortEmbeddedAgentRun,
      resolveActiveEmbeddedRunSessionId: runtimeAbortMocks.resolveActiveEmbeddedRunSessionId,
      markSessionAbortTarget: vi.fn(async () => ({
        entry: {
          sessionId,
          updatedAt: 10,
        },
        persisted: false,
        persistenceError: "simulated persistence failure",
        sessionId,
        sessionKey: canonicalKey,
      })),
      resolveSessionAbortTarget: vi.fn(() => ({
        entry: {
          sessionId,
          updatedAt: 10,
        },
        sessionId,
        sessionKey: canonicalKey,
      })),
      getLatestSubagentRunByChildSessionKey:
        subagentRegistryMocks.getLatestSubagentRunByChildSessionKey,
      listSubagentRunsForController: subagentRegistryMocks.listSubagentRunsForRequester,
      markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey: canonicalKey });

    const result = await runStopCommand({
      cfg,
      sessionKey: requestedKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(sessionId);
    expect(getFollowupQueueDepth(canonicalKey)).toBe(0);
    expectSessionLaneCleared(canonicalKey);
    expect(getAbortMemory(canonicalKey)).toBeUndefined();
  });

  it("fast-abort uses abort memory when no persisted target entry exists", async () => {
    const sessionKey = "telegram:missing-persistence-target";
    const { cfg } = await createAbortConfig();
    setAbortTestDeps({
      getAcpSessionManager: (() =>
        ({
          resolveSession: acpManagerMocks.resolveSession,
          cancelSession: acpManagerMocks.cancelSession,
        }) as never) as never,
      abortEmbeddedAgentRun: runtimeAbortMocks.abortEmbeddedAgentRun,
      resolveActiveEmbeddedRunSessionId: runtimeAbortMocks.resolveActiveEmbeddedRunSessionId,
      markSessionAbortTarget: vi.fn(async () => null),
      resolveSessionAbortTarget: vi.fn(() => null),
      getLatestSubagentRunByChildSessionKey:
        subagentRegistryMocks.getLatestSubagentRunByChildSessionKey,
      listSubagentRunsForController: subagentRegistryMocks.listSubagentRunsForRequester,
      markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
    });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
    });

    expect(result.handled).toBe(true);
    expect(getAbortMemory(sessionKey)).toBe(true);
  });

  it("fast-abort does not wait for abort metadata persistence before stopping runs", async () => {
    const sessionKey = "telegram:slow-persistence";
    const childKey = "agent:main:subagent:slow-persistence-child";
    const sessionId = "session-slow-persistence";
    const childSessionId = "session-slow-persistence-child";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [childKey]: childSessionId,
        [sessionKey]: sessionId,
      },
    });
    let finishPersistence: (() => void) | undefined;
    const persistenceStarted = new Promise<void>((resolveStarted) => {
      setAbortTestDeps({
        getAcpSessionManager: (() =>
          ({
            resolveSession: acpManagerMocks.resolveSession,
            cancelSession: acpManagerMocks.cancelSession,
          }) as never) as never,
        abortEmbeddedAgentRun: runtimeAbortMocks.abortEmbeddedAgentRun,
        resolveActiveEmbeddedRunSessionId: runtimeAbortMocks.resolveActiveEmbeddedRunSessionId,
        markSessionAbortTarget: vi.fn(
          () =>
            new Promise<SessionAbortTargetResult | null>((resolvePersistence) => {
              resolveStarted();
              finishPersistence = () => {
                resolvePersistence({
                  entry: {
                    sessionId,
                    updatedAt: 10,
                  },
                  persisted: true,
                  sessionId,
                  sessionKey,
                });
              };
            }),
        ),
        resolveSessionAbortTarget: vi.fn(() => ({
          entry: {
            sessionId,
            updatedAt: 10,
          },
          sessionId,
          sessionKey,
        })),
        getLatestSubagentRunByChildSessionKey:
          subagentRegistryMocks.getLatestSubagentRunByChildSessionKey,
        listSubagentRunsForController: subagentRegistryMocks.listSubagentRunsForRequester,
        markSubagentRunTerminated: subagentRegistryMocks.markSubagentRunTerminated,
      });
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    subagentRegistryMocks.listSubagentRunsForRequester.mockReturnValueOnce([
      {
        runId: "slow-child-run",
        childSessionKey: childKey,
        requesterSessionKey: sessionKey,
        requesterDisplayKey: sessionKey,
        task: "slow child",
        cleanup: "keep",
        createdAt: Date.now(),
      },
    ]);

    const resultPromise = runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
    });
    await persistenceStarted;

    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(sessionId);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith(childSessionId);
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledWith({
      childSessionKey: childKey,
      reason: "killed",
      runId: "slow-child-run",
      suppressTaskDelivery: true,
    });
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);

    finishPersistence?.();
    await expect(resultPromise).resolves.toMatchObject({
      aborted: true,
      handled: true,
    });
  });

  it("plain-language stop on ACP-bound session triggers ACP cancel", async () => {
    const sessionKey = "agent:codex:acp:test-1";
    const sessionId = "session-123";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey,
      meta: {} as never,
    });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
      targetSessionKey: sessionKey,
    });

    expect(result.handled).toBe(true);
    expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith({
      cfg,
      sessionKey,
      reason: "fast-abort",
      expectedTarget: expect.objectContaining({ sessionId }),
    });
  });

  it("ACP cancel failures do not skip queue and lane cleanup", async () => {
    const sessionKey = "agent:codex:acp:test-2";
    const sessionId = "session-456";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    enqueueQueuedFollowupRun({ root, cfg, sessionId, sessionKey });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey,
      meta: {} as never,
    });
    acpManagerMocks.cancelSession.mockRejectedValueOnce(new Error("cancel failed"));

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
      targetSessionKey: sessionKey,
    });

    expect(result.handled).toBe(true);
    expect(getFollowupQueueDepth(sessionKey)).toBe(0);
    expectSessionLaneCleared(sessionKey);
  });

  it("fast-abort of an ACP target also aborts the bound source dispatch lane", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C1";
    const acpSessionKey = "agent:codex:acp:bound-session";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    const sourceOperation = createReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-active-session",
      resetTriggered: false,
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "source-active-session",
      sessionKey: sourceSessionKey,
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "acp-store-session",
      sessionKey: acpSessionKey,
    });
    acpResetTargetTesting.setDepsForTest({
      getSessionBindingService: () =>
        ({
          resolveByConversation: () => ({
            targetKind: "session",
            targetSessionKey: acpSessionKey,
          }),
        }) as never,
      listAcpBindings: () => [],
      resolveConfiguredBindingRecord: () => null,
    });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: acpSessionKey,
      meta: {} as never,
    });

    const result = await runStopCommand({
      cfg,
      sessionKey: sourceSessionKey,
      from: "discord:C1",
      to: "discord:C1",
      targetSessionKey: acpSessionKey,
      commandSource: "native",
    });

    expect(result.handled).toBe(true);
    expect(sourceOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive(sourceSessionKey)).toBe(false);
    expect(getFollowupQueueDepth(sourceSessionKey)).toBe(0);
    expect(getFollowupQueueDepth(acpSessionKey)).toBe(0);
    expectSessionLaneCleared(sourceSessionKey);
    expectSessionLaneCleared(acpSessionKey);
    expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith({
      cfg,
      sessionKey: acpSessionKey,
      reason: "fast-abort",
      expectedTarget: expect.objectContaining({ sessionId: "acp-store-session" }),
    });
  });

  it("does not report /stop success after the active backend freezes its outcome", async () => {
    const sessionKey = "agent:main:telegram:direct:finalizing";
    const sessionId = "session-finalizing";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => false,
    });
    operation.setPhase("running");
    runtimeAbortMocks.abortEmbeddedAgentRun.mockReturnValue(false);
    runtimeAbortMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(sessionId);
    const markSessionAbortTarget = vi.fn();
    setAbortTestDeps({ markSessionAbortTarget });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:finalizing",
      to: "telegram:finalizing",
    });

    expect(result).toMatchObject({
      handled: true,
      aborted: false,
      rejectionReason: "finalizing",
    });
    expect(operation.result).toBeNull();
    expect(replyRunRegistry.isActive(sessionKey)).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(markSessionAbortTarget).not.toHaveBeenCalled();
    expect(getAbortMemory(sessionKey)).toBeUndefined();
    expect(formatAbortReplyText(undefined, result.rejectionReason)).toBe(
      "Agent reply is already finalizing and can no longer be aborted.",
    );
    operation.complete();
  });

  it("fast-abort of an ACP target aborts the source stored session when no source reply operation is registered", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C2";
    const acpSessionKey = "agent:codex:acp:bound-session-stored-source";
    const { root, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "source-store-session",
      sessionKey: sourceSessionKey,
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "acp-store-session",
      sessionKey: acpSessionKey,
    });
    acpResetTargetTesting.setDepsForTest({
      getSessionBindingService: () =>
        ({
          resolveByConversation: () => ({
            targetKind: "session",
            targetSessionKey: acpSessionKey,
          }),
        }) as never,
      listAcpBindings: () => [],
      resolveConfiguredBindingRecord: () => null,
    });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: acpSessionKey,
      meta: {} as never,
    });

    const result = await runStopCommand({
      cfg,
      sessionKey: sourceSessionKey,
      from: "discord:C2",
      to: "discord:C2",
      targetSessionKey: acpSessionKey,
      commandSource: "native",
    });

    expect(result.handled).toBe(true);
    expect(runtimeAbortMocks.abortEmbeddedAgentRun).toHaveBeenCalledWith("source-store-session");
    expect(getFollowupQueueDepth(sourceSessionKey)).toBe(0);
    expect(getFollowupQueueDepth(acpSessionKey)).toBe(0);
    expectSessionLaneCleared(sourceSessionKey);
    expectSessionLaneCleared(acpSessionKey);
  });

  it("does not abort the caller source lane for an unbound explicit ACP target", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C3";
    const acpSessionKey = "agent:codex:acp:unbound-explicit-target";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    const sourceOperation = createReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-active-session",
      resetTriggered: false,
    });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: acpSessionKey,
      meta: {} as never,
    });

    const result = await runStopCommand({
      cfg,
      sessionKey: sourceSessionKey,
      from: "discord:C3",
      to: "discord:C3",
      targetSessionKey: acpSessionKey,
      commandSource: "native",
    });

    expect(result.handled).toBe(true);
    expect(sourceOperation.result).toBeNull();
    expect(replyRunRegistry.isActive(sourceSessionKey)).toBe(true);
    expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith({
      cfg,
      sessionKey: acpSessionKey,
      reason: "fast-abort",
      expectedTarget: expect.objectContaining({ sessionId: "acp-store-session" }),
    });
    sourceOperation.complete();
  });

  it("uses ParentSessionKey as the source lane for a bound explicit ACP target", async () => {
    const sourceSessionKey = "agent:main:discord:channel:C4";
    const acpSessionKey = "agent:codex:acp:bound-parent-source";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    const sourceOperation = createReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-active-session",
      resetTriggered: false,
    });
    acpResetTargetTesting.setDepsForTest({
      getSessionBindingService: () =>
        ({
          resolveByConversation: () => ({
            targetKind: "session",
            targetSessionKey: acpSessionKey,
          }),
        }) as never,
      listAcpBindings: () => [],
      resolveConfiguredBindingRecord: () => null,
    });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: acpSessionKey,
      meta: {} as never,
    });

    const result = await runStopCommand({
      cfg,
      parentSessionKey: sourceSessionKey,
      from: "discord:C4",
      to: "discord:C4",
      targetSessionKey: acpSessionKey,
      commandSource: "native",
    });

    expect(result.handled).toBe(true);
    expect(sourceOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive(sourceSessionKey)).toBe(false);
  });

  it("fast-abort from an ACP-bound source conversation aborts source and bound ACP lanes", async () => {
    const sourceSessionKey = "agent:main:telegram:direct:source-1";
    const acpSessionKey = "agent:codex:acp:bound-source-stop";
    const { root, storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sourceSessionKey]: "source-store-session",
        [acpSessionKey]: "acp-store-session",
      },
    });
    const sourceOperation = createReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-active-session",
      resetTriggered: false,
    });
    const acpOperation = createReplyOperation({
      sessionKey: acpSessionKey,
      sessionId: "acp-active-session",
      resetTriggered: false,
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "source-active-session",
      sessionKey: sourceSessionKey,
    });
    enqueueQueuedFollowupRun({
      root,
      cfg,
      sessionId: "acp-active-session",
      sessionKey: acpSessionKey,
    });
    acpResetTargetTesting.setDepsForTest({
      getSessionBindingService: () =>
        ({
          resolveByConversation: () => ({
            targetKind: "session",
            targetSessionKey: acpSessionKey,
          }),
        }) as never,
      listAcpBindings: () => [],
      resolveConfiguredBindingRecord: () => null,
    });
    acpManagerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: acpSessionKey,
      meta: {} as never,
    });

    const result = await runStopCommand({
      cfg,
      sessionKey: sourceSessionKey,
      from: "telegram:source-1",
      to: "telegram:source-1",
      messageSid: "77",
      timestamp: 1234567890000,
    });

    expect(result.handled).toBe(true);
    expect(sourceOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(acpOperation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive(sourceSessionKey)).toBe(false);
    expect(replyRunRegistry.isActive(acpSessionKey)).toBe(false);
    expect(getFollowupQueueDepth(sourceSessionKey)).toBe(0);
    expect(getFollowupQueueDepth(acpSessionKey)).toBe(0);
    expectSessionLaneCleared(sourceSessionKey);
    expectSessionLaneCleared(acpSessionKey);
    expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith({
      cfg,
      sessionKey: acpSessionKey,
      reason: "fast-abort",
      expectedTarget: expect.objectContaining({ sessionId: "acp-store-session" }),
    });
    const sourceEntry = readAbortSessionEntry(storePath, sourceSessionKey);
    const acpEntry = readAbortSessionEntry(storePath, acpSessionKey);
    expect(sourceEntry?.abortCutoffMessageSid).toBe("77");
    expect(sourceEntry?.abortCutoffTimestamp).toBe(1234567890000);
    expect(acpEntry?.abortCutoffMessageSid).toBeUndefined();
    expect(acpEntry?.abortCutoffTimestamp).toBeUndefined();
  });

  it("persists abort cutoff metadata on /stop when command and target session match", async () => {
    const sessionKey = "telegram:123";
    const sessionId = "session-123";
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:123",
      to: "telegram:123",
      messageSid: "55",
      timestamp: 1234567890000,
    });

    expect(result.handled).toBe(true);
    const entry = readAbortSessionEntry(storePath, sessionKey);
    expect(entry?.abortedLastRun).toBe(true);
    expect(entry?.abortCutoffMessageSid).toBe("55");
    expect(entry?.abortCutoffTimestamp).toBe(1234567890000);
  });

  it("persists abort cutoff metadata when only ParentSessionKey identifies the command session", async () => {
    const sessionKey = "telegram:parent-only";
    const sessionId = "session-parent-only";
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [sessionKey]: sessionId },
    });

    const result = await runStopCommand({
      cfg,
      parentSessionKey: sessionKey,
      from: "telegram:parent-only",
      to: "telegram:parent-only",
      messageSid: "56",
      timestamp: 1234567890001,
    });

    expect(result.handled).toBe(true);
    const entry = readAbortSessionEntry(storePath, sessionKey);
    expect(entry?.abortedLastRun).toBe(true);
    expect(entry?.abortCutoffMessageSid).toBe("56");
    expect(entry?.abortCutoffTimestamp).toBe(1234567890001);
  });

  it("does not persist cutoff metadata when native /stop targets a different session", async () => {
    const slashSessionKey = "telegram:slash:123";
    const targetSessionKey = "agent:main:telegram:group:123";
    const targetSessionId = "session-target";
    const { storePath, cfg } = await createAbortConfig({
      sessionIdsByKey: { [targetSessionKey]: targetSessionId },
    });

    const result = await runStopCommand({
      cfg,
      sessionKey: slashSessionKey,
      from: "telegram:123",
      to: "telegram:123",
      targetSessionKey,
      messageSid: "999",
      timestamp: 1234567890000,
    });

    expect(result.handled).toBe(true);
    const entry = readAbortSessionEntry(storePath, targetSessionKey);
    expect(entry?.abortedLastRun).toBe(true);
    expect(entry?.abortCutoffMessageSid).toBeUndefined();
    expect(entry?.abortCutoffTimestamp).toBeUndefined();
  });

  it("fast-abort stops active subagent runs for requester session", async () => {
    const sessionKey = "telegram:parent";
    const childKey = "agent:main:subagent:child-1";
    const sessionId = "session-parent";
    const childSessionId = "session-child";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sessionKey]: sessionId,
        [childKey]: childSessionId,
      },
    });

    subagentRegistryMocks.listSubagentRunsForRequester.mockReturnValueOnce([
      {
        runId: "run-1",
        childSessionKey: childKey,
        requesterSessionKey: sessionKey,
        requesterDisplayKey: "telegram:parent",
        task: "do work",
        cleanup: "keep",
        createdAt: Date.now(),
      },
    ]);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:parent",
      to: "telegram:parent",
    });

    expect(result.stoppedSubagents).toBe(1);
    expectSessionLaneCleared(childKey);
  });

  it("continues stopping siblings when one termination persistence write fails", () => {
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const sessionKey = "telegram:persistence-failure-parent";
    const firstChildKey = "agent:main:subagent:persistence-failure-first";
    const secondChildKey = "agent:main:subagent:persistence-failure-second";
    const run = (runId: string, childSessionKey: string): SubagentRunRecord => ({
      runId,
      childSessionKey,
      requesterSessionKey: sessionKey,
      requesterDisplayKey: sessionKey,
      task: "stop despite persistence failure",
      cleanup: "keep",
      createdAt: Date.now(),
    });
    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        run("run-persistence-failure-first", firstChildKey),
        run("run-persistence-failure-second", secondChildKey),
      ])
      .mockReturnValue([]);
    subagentRegistryMocks.markSubagentRunTerminated
      .mockImplementationOnce(() => {
        throw new Error("sqlite busy");
      })
      .mockReturnValue(1);

    expect(
      stopSubagentsForRequester({
        cfg: {} as OpenClawConfig,
        requesterSessionKey: sessionKey,
      }),
    ).toEqual({ stopped: 2 });
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledTimes(2);
    expectSessionLaneCleared(firstChildKey);
    expectSessionLaneCleared(secondChildKey);
  });

  it("cascade stop kills depth-2 children when stopping depth-1 agent", async () => {
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-1";
    const depth2Key = "agent:main:subagent:child-1:subagent:grandchild-1";
    const sessionId = "session-parent";
    const depth1SessionId = "session-child";
    const depth2SessionId = "session-grandchild";
    const { cfg } = await createAbortConfig({
      sessionIdsByKey: {
        [sessionKey]: sessionId,
        [depth1Key]: depth1SessionId,
        [depth2Key]: depth2SessionId,
      },
    });

    // First call: main session lists depth-1 children
    // Second call (cascade): depth-1 session lists depth-2 children
    // Third call (cascade from depth-2): no further children
    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          runId: "run-1",
          childSessionKey: depth1Key,
          requesterSessionKey: sessionKey,
          requesterDisplayKey: "telegram:parent",
          task: "orchestrator",
          cleanup: "keep",
          createdAt: Date.now(),
        },
      ])
      .mockReturnValueOnce([
        {
          runId: "run-2",
          childSessionKey: depth2Key,
          requesterSessionKey: depth1Key,
          requesterDisplayKey: depth1Key,
          task: "leaf worker",
          cleanup: "keep",
          createdAt: Date.now(),
        },
      ])
      .mockReturnValueOnce([]);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:parent",
      to: "telegram:parent",
    });

    // Should stop both depth-1 and depth-2 agents (cascade)
    expect(result.stoppedSubagents).toBe(2);
    expectSessionLaneCleared(depth1Key);
    expectSessionLaneCleared(depth2Key);
  });

  it("stops a subagent that is paused after yielding", () => {
    subagentRegistryMocks.listSubagentRunsForRequester.mockClear();
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const sessionKey = "telegram:yield-parent";
    const childKey = "agent:main:subagent:yield-child";
    const now = Date.now();
    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          runId: "run-yield-child",
          childSessionKey: childKey,
          requesterSessionKey: sessionKey,
          requesterDisplayKey: sessionKey,
          task: "paused worker",
          cleanup: "keep",
          createdAt: now - 1_000,
          endedAt: now - 500,
          pauseReason: "sessions_yield",
        },
      ])
      .mockReturnValueOnce([]);

    const result = stopSubagentsForRequester({
      cfg: {} as OpenClawConfig,
      requesterSessionKey: sessionKey,
    });

    expect(result).toEqual({ stopped: 1 });
    expectSessionLaneCleared(childKey);
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledWith({
      runId: "run-yield-child",
      childSessionKey: childKey,
      reason: "killed",
      suppressTaskDelivery: true,
    });
  });

  it("cascade stop traverses ended depth-1 parents to stop active depth-2 children", async () => {
    subagentRegistryMocks.listSubagentRunsForRequester.mockClear();
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-ended";
    const depth2Key = "agent:main:subagent:child-ended:subagent:grandchild-active";
    const now = Date.now();
    const { cfg } = await createAbortConfig({
      nowMs: now,
      sessionIdsByKey: {
        [sessionKey]: "session-parent",
        [depth1Key]: "session-child-ended",
        [depth2Key]: "session-grandchild-active",
      },
    });

    // main -> ended depth-1 parent
    // depth-1 parent -> active depth-2 child
    // depth-2 child -> none
    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          runId: "run-1",
          childSessionKey: depth1Key,
          requesterSessionKey: sessionKey,
          requesterDisplayKey: "telegram:parent",
          task: "orchestrator",
          cleanup: "keep",
          createdAt: now - 1_000,
          endedAt: now - 500,
          outcome: { status: "ok" },
        },
      ])
      .mockReturnValueOnce([
        {
          runId: "run-2",
          childSessionKey: depth2Key,
          requesterSessionKey: depth1Key,
          requesterDisplayKey: depth1Key,
          task: "leaf worker",
          cleanup: "keep",
          createdAt: now - 500,
        },
      ])
      .mockReturnValueOnce([]);

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:parent",
      to: "telegram:parent",
    });

    // Should skip killing the ended depth-1 run itself, but still kill depth-2.
    expect(result.stoppedSubagents).toBe(1);
    expectSessionLaneCleared(depth2Key);
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledTimes(1);
    const [terminatedRun] = expectDefined(
      (
        subagentRegistryMocks.markSubagentRunTerminated.mock.calls as unknown as Array<
          [{ runId?: string; childSessionKey?: string }]
        >
      )[0],
      "(subagentRegistryMocks.markSubagentRunTerminated.mock.calls as unknown as Array<\n        [{ runId?: string; childSessionKey?: string }]\n      >)[0] test invariant",
    );
    expect(terminatedRun.runId).toBe("run-2");
    expect(terminatedRun.childSessionKey).toBe(depth2Key);
  });

  it("cascade stop still traverses an ended current parent when a stale older active row exists", async () => {
    subagentRegistryMocks.listSubagentRunsForRequester.mockClear();
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const sessionKey = "telegram:parent";
    const depth1Key = "agent:main:subagent:child-ended-stale";
    const depth2Key = "agent:main:subagent:child-ended-stale:subagent:grandchild-active";
    const now = Date.now();
    const { cfg } = await createAbortConfig({
      nowMs: now,
      sessionIdsByKey: {
        [sessionKey]: "session-parent",
        [depth1Key]: "session-child-ended-stale",
        [depth2Key]: "session-grandchild-active",
      },
    });

    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          runId: "run-stale-parent",
          childSessionKey: depth1Key,
          requesterSessionKey: sessionKey,
          requesterDisplayKey: "telegram:parent",
          task: "stale orchestrator",
          cleanup: "keep",
          createdAt: now - 2_000,
          startedAt: now - 1_900,
        },
        {
          runId: "run-current-parent",
          childSessionKey: depth1Key,
          requesterSessionKey: sessionKey,
          requesterDisplayKey: "telegram:parent",
          task: "current orchestrator",
          cleanup: "keep",
          createdAt: now - 1_000,
          startedAt: now - 900,
          endedAt: now - 500,
          outcome: { status: "ok" },
        },
      ])
      .mockReturnValueOnce([
        {
          runId: "run-active-child",
          childSessionKey: depth2Key,
          requesterSessionKey: depth1Key,
          requesterDisplayKey: depth1Key,
          task: "leaf worker",
          cleanup: "keep",
          createdAt: now - 400,
        },
      ])
      .mockReturnValueOnce([]);
    subagentRegistryMocks.getLatestSubagentRunByChildSessionKey.mockImplementation(
      (childSessionKey) => {
        if (childSessionKey === depth1Key) {
          return {
            runId: "run-current-parent",
            childSessionKey: depth1Key,
            requesterSessionKey: sessionKey,
            requesterDisplayKey: "telegram:parent",
            task: "current orchestrator",
            cleanup: "keep",
            createdAt: now - 1_000,
            startedAt: now - 900,
            endedAt: now - 500,
            outcome: { status: "ok" },
          } as SubagentRunRecord;
        }
        if (childSessionKey === depth2Key) {
          return {
            runId: "run-active-child",
            childSessionKey: depth2Key,
            requesterSessionKey: depth1Key,
            requesterDisplayKey: depth1Key,
            task: "leaf worker",
            cleanup: "keep",
            createdAt: now - 400,
          } as SubagentRunRecord;
        }
        return null;
      },
    );

    const result = await runStopCommand({
      cfg,
      sessionKey,
      from: "telegram:parent",
      to: "telegram:parent",
    });

    expect(result.stoppedSubagents).toBe(1);
    expectSessionLaneCleared(depth2Key);
    expect(subagentRegistryMocks.markSubagentRunTerminated).toHaveBeenCalledTimes(1);
    const [terminatedRun] = expectDefined(
      (
        subagentRegistryMocks.markSubagentRunTerminated.mock.calls as unknown as Array<
          [{ runId?: string; childSessionKey?: string }]
        >
      )[0],
      "(subagentRegistryMocks.markSubagentRunTerminated.mock.calls as unknown as Array<\n        [{ runId?: string; childSessionKey?: string }]\n      >)[0] test invariant",
    );
    expect(terminatedRun.runId).toBe("run-active-child");
    expect(terminatedRun.childSessionKey).toBe(depth2Key);
  });

  it("stopSubagentsForRequester does not traverse a child that moved to a newer parent", () => {
    subagentRegistryMocks.listSubagentRunsForRequester.mockClear();
    subagentRegistryMocks.markSubagentRunTerminated.mockClear();
    const oldParentKey = "agent:main:subagent:old-parent";
    const newParentKey = "agent:main:subagent:new-parent";
    const childKey = "agent:main:subagent:shared-child";
    const leafKey = `${childKey}:subagent:leaf`;
    const now = Date.now();

    subagentRegistryMocks.listSubagentRunsForRequester
      .mockReturnValueOnce([
        {
          runId: "run-shared-child-stale-parent",
          childSessionKey: childKey,
          requesterSessionKey: oldParentKey,
          controllerSessionKey: oldParentKey,
          requesterDisplayKey: oldParentKey,
          task: "shared child stale parent",
          cleanup: "keep",
          createdAt: now - 2_000,
          endedAt: now - 1_000,
          outcome: { status: "ok" },
        },
      ])
      .mockReturnValueOnce([
        {
          runId: "run-leaf-active",
          childSessionKey: leafKey,
          requesterSessionKey: childKey,
          controllerSessionKey: childKey,
          requesterDisplayKey: childKey,
          task: "leaf worker",
          cleanup: "keep",
          createdAt: now - 500,
        },
      ]);
    subagentRegistryMocks.getLatestSubagentRunByChildSessionKey.mockImplementation((sessionKey) => {
      if (sessionKey === childKey) {
        return {
          runId: "run-shared-child-current-parent",
          childSessionKey: childKey,
          requesterSessionKey: newParentKey,
          controllerSessionKey: newParentKey,
          requesterDisplayKey: newParentKey,
          task: "shared child current parent",
          cleanup: "keep",
          createdAt: now - 250,
        } as SubagentRunRecord;
      }
      if (sessionKey === leafKey) {
        return {
          runId: "run-leaf-active",
          childSessionKey: leafKey,
          requesterSessionKey: childKey,
          controllerSessionKey: childKey,
          requesterDisplayKey: childKey,
          task: "leaf worker",
          cleanup: "keep",
          createdAt: now - 500,
        } as SubagentRunRecord;
      }
      return null;
    });

    const result = stopSubagentsForRequester({
      cfg: {} as OpenClawConfig,
      requesterSessionKey: oldParentKey,
    });

    expect(result).toEqual({ stopped: 0 });
    expect(subagentRegistryMocks.markSubagentRunTerminated).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
