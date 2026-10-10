import { AsyncResource } from "node:async_hooks";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  deleteSession,
  getSession,
  waitForExecSession,
  type ProcessSession,
} from "../../agents/bash-process-registry.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { createLazyExecTool } from "../../agents/lazy-exec-tool.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  releaseSubagentRun,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { captureSessionEntryCurrentCheck } from "../../config/sessions/session-entry-current-check.js";
import {
  publishSystemEventStoreConfig,
  resolvePhysicalSessionStorePath,
} from "../../config/sessions/session-store-path.js";
import {
  captureExecRequestOwners,
  withExecRequestTurn,
  type ExecRequestIdentity,
  type ExecRequestOwner,
} from "../../infra/exec-request-context.js";
import {
  getConversationSession,
  normalizeSessionDeliveryState,
  patchSessionEntry,
} from "../../plugin-sdk/session-store-runtime.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { executeFastAbortRequest } from "./abort-operation.js";
import { tryFastAbortFromMessage } from "./abort.js";
import { handleStopCommand } from "./commands-session-abort.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { enqueueFollowupRun, getFollowupQueueDepth } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearFollowupDrainCallback } from "./queue/drain.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

const dirs = createSuiteTempRootTracker({ prefix: "openclaw-stop-owner-" });
const sessionKey = "agent:main:slack:group:g12345678";

beforeAll(() => dirs.setup());
afterAll(() => dirs.cleanup());
afterEach(() => {
  clearFollowupQueue(sessionKey);
  clearFollowupDrainCallback(sessionKey);
  testing.resetReplyRunRegistry();
});

async function setupStop(createEntry = true) {
  const root = await dirs.make("case");
  const storePath = path.join(root, "sessions.json");
  const cfg = { session: { store: storePath }, commands: { allowFrom: { "*": ["*"] } } };
  const entry = { sessionId: "session-a", updatedAt: Date.now() };
  await replaceSessionEntry(
    { storePath, sessionKey: createEntry ? sessionKey : "agent:main:other" },
    entry,
  );
  const ctx = buildTestCtx({
    Body: "/stop",
    CommandBody: "/stop",
    RawBody: "/stop",
    Provider: "slack",
    Surface: "slack",
    From: "slack:U12345678",
    To: "slack:G12345678",
    SenderId: "U12345678",
    CommandSource: "native",
    CommandAuthorized: true,
    SessionKey: "slack:slash:U12345678",
    CommandTargetSessionKey: sessionKey,
  });
  const isCommandTargetCurrent = () =>
    loadSessionEntry({ storePath, sessionKey })?.sessionId === entry.sessionId;
  const params: HandleCommandsParams = {
    cfg,
    ctx,
    command: {
      commandBodyNormalized: "/stop",
      rawBodyNormalized: "/stop",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "U12345678",
      channel: "slack",
      surface: "slack",
      ownerList: [],
    },
    agentId: "main",
    directives: parseInlineSessionDirectives(""),
    elevated: { enabled: false, allowed: false, failures: [] },
    sessionKey: ctx.SessionKey ?? "",
    sessionStore: createEntry ? { [sessionKey]: entry } : {},
    storePath,
    workspaceDir: root,
    defaultGroupActivation: () => "always",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedBlockStreamingBreak: "text_end",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-test",
    contextTokens: 1000,
    isGroup: true,
    opts: { isCommandTargetCurrent },
  };
  return { cfg, ctx, entry, params, storePath, isCommandTargetCurrent };
}

it.each([false, true])(
  "retires idle MCP state while preserving a later lease=%s",
  async (laterLease) => {
    const state = await setupStop();
    const { getOrCreateSessionMcpRuntime, unopenedMcpConfig } =
      await import("../../agents/agent-bundle-mcp-manager.test-support.js");
    const { getSessionMcpRuntimeManagerForTesting, setSessionMcpRuntimeScheduler } =
      await import("../../agents/agent-bundle-mcp-manager-api.js");
    const scheduler = createTestGatewayScheduler();
    onTestFinished(() => scheduler.stop());
    await setSessionMcpRuntimeScheduler(scheduler);
    const manager = getSessionMcpRuntimeManagerForTesting();
    try {
      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: state.entry.sessionId,
        sessionKey,
        workspaceDir: state.params.workspaceDir,
        cfg: unopenedMcpConfig,
        manifestRegistry: { plugins: [] },
      });
      expect(manager.peekSession({ sessionId: state.entry.sessionId })).toBe(runtime);
      const stopping = executeFastAbortRequest(state, {
        commandSessionKey: state.ctx.SessionKey,
        targetKey: sessionKey,
        resolveTargetAgentId: () => "main",
      });
      const releaseLease = laterLease
        ? expectDefined(runtime.acquireLease, "runtime lease")()
        : undefined;
      try {
        await stopping;
        expect(manager.peekSession({ sessionId: state.entry.sessionId })).toBe(
          laterLease ? runtime : undefined,
        );
      } finally {
        releaseLease?.();
      }
      await manager.completeDeferredRetirement(state.entry.sessionId, runtime);
      expect(manager.peekSession({ sessionId: state.entry.sessionId })).toBeUndefined();
    } finally {
      await manager.disposeAll();
    }
  },
);

describe.each(["fast", "command"] as const)("%s Stop current owner", (pathKind) => {
  it.each(["completed", "running", "backend-error", "cleanup-error"] as const)(
    "stops a %s request's command while preserving its independent service",
    async (phase) => {
      const state = await setupStop();
      const runId = `channel-owned-exec-${pathKind}`;
      const operation = createReplyOperation({
        agentId: "main",
        sessionKey,
        sessionId: state.entry.sessionId,
        resetTriggered: false,
      });
      const commands: ProcessSession[] = [];
      const supervisor = getProcessSupervisor();
      const spawn = supervisor.spawn.bind(supervisor);
      let spawned = 0;
      const cleanupFailure =
        phase === "cleanup-error"
          ? vi.spyOn(supervisor, "spawn").mockImplementation(async (input) => {
              const managed = await spawn(input);
              if (spawned++ > 0) {
                return managed;
              }
              return {
                ...managed,
                waitForExtinction: async () => {
                  await managed.wait();
                  await managed.waitForExtinction?.();
                  throw new Error("Synthetic command finalization failure");
                },
              };
            })
          : undefined;
      const releaseWriter = createDeferred();
      let writer: Promise<unknown> | undefined;
      let child: ReturnType<typeof createReplyOperation> | undefined;
      const childRunId = `cleanup-child-${pathKind}`;
      // Native callbacks can load the lazy tool outside its construction's async context.
      const callback = new AsyncResource("channel-exec-callback");
      try {
        const [ordinary, service] = await withEnvAsync({ OPENCLAW_EXEC_SHELL_SNAPSHOT: "0" }, () =>
          withExecRequestTurn(
            {
              identity: { runId, sessionKey, sessionId: state.entry.sessionId, agentId: "main" },
              abortSignal: operation.abortSignal,
            },
            async () => {
              const exec = createLazyExecTool({
                runId,
                sessionKey,
                sessionId: state.entry.sessionId,
                agentId: "main",
                config: state.cfg,
                cwd: state.params.workspaceDir,
                scopeKey: sessionKey,
                host: "gateway",
                mode: "full",
                ask: "off",
                allowBackground: true,
                notifyOnExit: false,
                preparedStoreEnvironment: {},
              });
              return callback.runInAsyncScope(async () => {
                for (const background of [false, true]) {
                  const result = await exec.execute(
                    background ? "independent-service" : "ordinary-command",
                    {
                      command: `node -e "require('fs').watch('.', () => {})"`,
                      ...(background ? { background: true } : { yieldMs: 10 }),
                      timeoutSeconds: 60,
                    },
                    operation.abortSignal,
                  );
                  const details = asOptionalRecord(result.details);
                  expect(details?.status).toBe("running");
                  if (typeof details?.sessionId !== "string") {
                    throw new Error("Expected a running command's process handle");
                  }
                  commands.push(expectDefined(getSession(details.sessionId), "running command"));
                }
                return commands;
              });
            },
          ),
        );
        const ordinaryCommand = expectDefined(ordinary, "ordinary command");
        const independentService = expectDefined(service, "independent service");
        if (phase === "completed" || phase === "cleanup-error") {
          operation.complete();
        } else {
          operation.attachBackend({
            kind: "embedded",
            cancel: () => {
              if (phase === "backend-error") {
                throw new Error("Synthetic backend cancellation failure");
              }
            },
            isStreaming: () => true,
          });
          operation.setPhase("running");
        }
        expect(ordinaryCommand.exited).toBe(false);
        expect(independentService.exited).toBe(false);

        if (phase === "cleanup-error") {
          const childKey = `agent:main:subagent:${childRunId}`;
          const childSessionId = `session-${childRunId}`;
          await replaceSessionEntry(
            { storePath: state.storePath, sessionKey: childKey },
            { sessionId: childSessionId, updatedAt: Date.now() },
          );
          publishSystemEventStoreConfig(state.cfg);
          const controllerStorePath = resolvePhysicalSessionStorePath(
            { sessionKey, agentId: "main" },
            state.cfg,
          );
          await addSubagentRunForTests({
            runId: childRunId,
            childSessionKey: childKey,
            childAgentId: "main",
            requesterSessionKey: sessionKey,
            requesterAgentId: "main",
            requesterDisplayKey: sessionKey,
            requesterStorePath: controllerStorePath,
            controllerSessionKey: sessionKey,
            controllerStorePath,
            task: "selected child survives no accepted Stop",
            cleanup: "keep",
            expectsCompletionMessage: false,
          });
          child = createReplyOperation({
            agentId: "main",
            sessionKey: childKey,
            sessionId: childSessionId,
            resetTriggered: false,
          });
          child.attachBackend({
            kind: "embedded",
            runId: childRunId,
            isStreaming: () => true,
            cancel: () => child?.complete(),
          });
          child.setPhase("running");
        }
        // Denied and stale channel dispatch must leave the real command untouched.
        await (pathKind === "fast"
          ? tryFastAbortFromMessage({
              ...state,
              cfg: { ...state.cfg, commands: { allowFrom: { "*": [] } } },
            })
          : handleStopCommand(
              { ...state.params, command: { ...state.params.command, isAuthorizedSender: false } },
              true,
            ));
        expect(ordinaryCommand.cancellationRequested).not.toBe(true);
        await expect(
          pathKind === "fast"
            ? tryFastAbortFromMessage({ ...state, isCommandTargetCurrent: () => false })
            : handleStopCommand(
                { ...state.params, opts: { isCommandTargetCurrent: () => false } },
                true,
              ),
        ).rejects.toThrow("selected session changed");
        expect(ordinaryCommand.cancellationRequested).not.toBe(true);
        expect(child?.abortSignal.aborted).not.toBe(true);
        if (pathKind === "fast" && phase === "backend-error") {
          const writerEntered = createDeferred();
          writer = patchSessionEntry({
            storePath: state.storePath,
            sessionKey,
            update: async () => {
              writerEntered.resolve();
              await releaseWriter.promise;
              return { updatedAt: Date.now() };
            },
          });
          await writerEntered.promise;
        }
        const stopping =
          pathKind === "fast"
            ? tryFastAbortFromMessage(state)
            : handleStopCommand(state.params, true);
        if (phase === "backend-error" || phase === "cleanup-error") {
          const rejection = expect(stopping).rejects.toThrow(
            phase === "backend-error"
              ? "Synthetic backend cancellation failure"
              : "command cleanup could not be confirmed",
          );
          if (writer) {
            await waitForExecSession(ordinaryCommand);
            // Rejection tracking runs between event-loop turns while metadata stays blocked.
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            releaseWriter.resolve();
            await writer;
          }
          await rejection;
        } else {
          expect(await stopping).toMatchObject(
            pathKind === "fast"
              ? { handled: true, aborted: true }
              : { shouldContinue: false, reply: { text: "⚙️ Agent was aborted." } },
          );
        }
        if (child) {
          expect(child.abortSignal.aborted).toBe(true);
          expect(child.result).toMatchObject({ kind: "aborted", code: "aborted_by_user" });
          expect((await getSubagentRunByChildSessionKey(child.key))?.endedReason).toBe(
            "subagent-killed",
          );
        }
        expect(ordinaryCommand).toMatchObject({ exited: true, exitReason: "manual-cancel" });
        expect(ordinaryCommand.finalizationFailed === true).toBe(phase === "cleanup-error");
        expect(independentService.exited).toBe(false);
        expect(independentService.cancellationRequested).not.toBe(true);
        expect(operation.result).toMatchObject({
          kind: phase === "completed" || phase === "cleanup-error" ? "completed" : "aborted",
        });
        if (phase === "completed" || phase === "running") {
          expect(loadSessionEntry({ storePath: state.storePath, sessionKey })).toMatchObject({
            sessionId: state.entry.sessionId,
            abortedLastRun: true,
          });
        }
      } finally {
        releaseWriter.resolve();
        await writer;
        operation.complete();
        callback.emitDestroy();
        cleanupFailure?.mockRestore();
        child?.complete();
        if (phase === "cleanup-error") {
          await releaseSubagentRun(childRunId);
          publishSystemEventStoreConfig(getRuntimeConfig());
        }
        for (const command of commands) {
          getProcessSupervisor().cancel(command.id, "manual-cancel");
        }
        await Promise.all(commands.map(waitForExecSession));
        for (const command of commands) {
          deleteSession(command.id);
        }
      }
    },
  );

  it.each(["reply", "embedded", "new-session"] as const)(
    "preserves later human %s work across Stop preparation",
    async (backend) => {
      const state = await setupStop(backend !== "new-session");
      const release = createDeferred();
      const owners: ExecRequestOwner[] = [];
      const executions: Promise<void>[] = [];
      const start = (identity: ExecRequestIdentity) => {
        executions.push(
          withExecRequestTurn({ identity }, async () => {
            owners.push(expectDefined(captureExecRequestOwners(identity)?.[0], "request owner"));
            await release.promise;
          }),
        );
      };
      const target = {
        sessionKey,
        sessionId: state.entry.sessionId,
        agentId: "main",
      };
      start({ ...target, runId: "selected" });
      start({ ...target, runId: "other-agent", agentId: "other" });
      start({ ...target, runId: "other-session", sessionId: "unrelated-session" });
      start({ ...target, runId: "other-key", sessionKey: "agent:main:other" });
      owners[0]!.signal.addEventListener(
        "abort",
        () => start({ ...target, runId: "during-signal" }),
        {
          once: true,
        },
      );
      const nativeAbort = vi.fn();
      const native = createEmbeddedRunHandle({ abort: nativeAbort });
      const original =
        backend === "new-session"
          ? createReplyOperation({
              agentId: "main",
              sessionKey,
              sessionId: state.entry.sessionId,
              resetTriggered: false,
            })
          : undefined;
      let replacement: ReturnType<typeof createReplyOperation> | undefined;
      const lane = resolveEmbeddedSessionLane(sessionKey);
      const blocker = enqueueCommandInLane(lane, () => release.promise);
      const selectedQueued = vi.fn(async () => {});
      const selectedAdmission = enqueueCommandInLane(lane, selectedQueued, {
        sessionTarget: target,
      }).catch((error: unknown) => error);
      const selectedFollowup = createQueueTestRun({ prompt: "selected pending input" });
      selectedFollowup.run = { ...selectedFollowup.run, ...target };
      enqueueFollowupRun(
        sessionKey,
        selectedFollowup,
        { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
        "none",
      );
      const laterQueued = vi.fn(async () => {});
      let laterAdmission: Promise<unknown> | undefined;
      try {
        const stopping =
          pathKind === "fast"
            ? executeFastAbortRequest(
                {
                  ...state,
                  isCommandTargetCurrent:
                    backend === "new-session" ? undefined : state.isCommandTargetCurrent,
                },
                {
                  commandSessionKey: state.ctx.SessionKey,
                  targetKey: sessionKey,
                  resolveTargetAgentId: () => "main",
                },
              )
            : handleStopCommand(
                {
                  ...state.params,
                  opts: backend === "new-session" ? undefined : state.params.opts,
                },
                true,
              );
        original?.complete();
        start({ ...target, runId: "during-preparation" });
        laterAdmission = enqueueCommandInLane(lane, laterQueued, { sessionTarget: target }).catch(
          (error: unknown) => error,
        );
        const laterFollowup = createQueueTestRun({ prompt: "later human input" });
        laterFollowup.run = { ...laterFollowup.run, ...target };
        enqueueFollowupRun(
          sessionKey,
          laterFollowup,
          { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
          "none",
        );
        if (backend === "new-session") {
          replaceSessionEntrySync(
            { storePath: state.storePath, sessionKey },
            { ...state.entry, activeWriterRunId: "later-human" },
          );
        }
        if (backend !== "embedded") {
          replacement = createReplyOperation({
            agentId: "main",
            sessionKey,
            sessionId: state.entry.sessionId,
            resetTriggered: false,
          });
        } else {
          setActiveEmbeddedRun(state.entry.sessionId, native, sessionKey, undefined, "main");
        }
        await stopping;
        expect(owners.map((owner) => [owner.identity.runId, owner.signal.aborted])).toEqual([
          ["selected", true],
          ["other-agent", false],
          ["other-session", false],
          ["other-key", false],
          ["during-preparation", false],
          ["during-signal", false],
        ]);
        expect(replacement?.abortSignal.aborted).not.toBe(true);
        expect(nativeAbort).not.toHaveBeenCalled();
        if (backend === "new-session") {
          expect(
            loadSessionEntry({ storePath: state.storePath, sessionKey })?.abortedLastRun,
          ).not.toBe(true);
        }
        expect(await selectedAdmission).toBeInstanceOf(Error);
        expect(selectedQueued).not.toHaveBeenCalled();
        expect(getExistingFollowupQueue(sessionKey)?.items).toEqual([laterFollowup]);
        release.resolve();
        expect(await laterAdmission).toBeUndefined();
        expect(laterQueued).toHaveBeenCalledOnce();
      } finally {
        replacement?.complete();
        original?.complete();
        clearActiveEmbeddedRun(state.entry.sessionId, native, sessionKey);
        release.resolve();
        await Promise.allSettled([blocker, selectedAdmission, laterAdmission]);
        await Promise.all(executions);
      }
    },
  );

  it.each([
    { agentId: "selected", activeAgentId: "selected", otherAgentId: "other" },
    { agentId: "research", activeAgentId: "main", otherAgentId: "main" },
  ])(
    "stops only $agentId's global session with $activeAgentId active",
    async ({ agentId, activeAgentId, otherAgentId }) => {
      const state = await setupStop();
      const globalKey = "global";
      const storePath = path.join(
        state.params.workspaceDir,
        "agents",
        agentId,
        "sessions",
        "sessions.json",
      );
      const cfg = {
        ...state.cfg,
        agents: { ownership: "explicit" as const, entries: { [otherAgentId]: {}, [agentId]: {} } },
        session: {
          scope: "global" as const,
          store: path.join(
            state.params.workspaceDir,
            "agents",
            "{agentId}",
            "sessions",
            "sessions.json",
          ),
        },
      };
      const scope = { agentId, storePath, sessionKey: globalKey };
      await replaceSessionEntry(scope, state.entry);
      const otherEntry = { ...state.entry, sessionId: "session-other" };
      const otherScope = {
        agentId: otherAgentId,
        storePath: path.join(
          state.params.workspaceDir,
          "agents",
          otherAgentId,
          "sessions",
          "sessions.json",
        ),
        sessionKey: globalKey,
      };
      await replaceSessionEntry(otherScope, otherEntry);
      const ctx = { ...state.ctx, AgentId: agentId, CommandTargetSessionKey: globalKey };
      const isCommandTargetCurrent = () =>
        loadSessionEntry(scope)?.sessionId === state.entry.sessionId;
      const ownsActiveRun = agentId === activeAgentId;
      const operation = createReplyOperation({
        agentId: activeAgentId,
        sessionKey: globalKey,
        sessionId: ownsActiveRun ? state.entry.sessionId : otherEntry.sessionId,
        resetTriggered: false,
      });
      operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
      try {
        const followups = [
          { ownerAgentId: agentId, sessionId: state.entry.sessionId },
          { ownerAgentId: otherAgentId, sessionId: otherEntry.sessionId },
        ].map(({ ownerAgentId, sessionId }) => {
          const followup = createQueueTestRun({ prompt: `${ownerAgentId} pending input` });
          followup.run = {
            ...followup.run,
            agentId: ownerAgentId,
            sessionKey: globalKey,
            sessionId,
          };
          enqueueFollowupRun(
            globalKey,
            followup,
            { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
            "none",
          );
          return followup;
        });
        const result = await (pathKind === "fast"
          ? tryFastAbortFromMessage({ cfg, ctx, isCommandTargetCurrent })
          : handleStopCommand(
              {
                ...state.params,
                cfg,
                ctx,
                agentId,
                sessionKey: globalKey,
                sessionStore: { [globalKey]: state.entry },
                storePath,
                opts: { isCommandTargetCurrent },
              },
              true,
            ));
        expect.soft(operation.abortSignal.aborted).toBe(ownsActiveRun);
        expect.soft(getExistingFollowupQueue(globalKey)?.items).toEqual([followups[1]]);
        expect(result).toMatchObject(
          pathKind === "fast"
            ? { handled: true, aborted: ownsActiveRun }
            : { shouldContinue: false, reply: { text: "⚙️ Agent was aborted." } },
        );
        expect(loadSessionEntry(scope)).toMatchObject({
          sessionId: state.entry.sessionId,
          abortedLastRun: true,
        });
        expect(loadSessionEntry(otherScope)?.abortedLastRun).not.toBe(true);
      } finally {
        operation.complete();
        clearFollowupQueue(globalKey);
        clearFollowupDrainCallback(globalKey);
      }
    },
  );

  it("does not reclaim a conversation reassigned after abort preparation", async () => {
    const state = await setupStop();
    const nextKey = `${sessionKey}:thread:123.456`;
    const address = {
      agentId: "main",
      storePath: state.storePath,
      channel: "slack",
      accountId: "default",
      kind: "group" as const,
      peerId: "g12345678",
      threadId: "123.456",
    };
    const delivery = normalizeSessionDeliveryState({
      context: {
        channel: "slack",
        accountId: "default",
        to: "group:g12345678",
        threadId: "123.456",
      },
    });
    await replaceSessionEntry(
      { storePath: state.storePath, sessionKey },
      { ...state.entry, updatedAt: 100, chatType: "group", delivery },
    );
    const operation = createReplyOperation({
      sessionKey,
      sessionId: state.entry.sessionId,
      resetTriggered: false,
    });
    operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
    let reassigned = false;
    state.isCommandTargetCurrent = () => {
      const current = getConversationSession(address);
      if (
        !reassigned &&
        operation.abortSignal.aborted &&
        (pathKind === "fast" || state.params.sessionStore?.[sessionKey]?.abortedLastRun === true)
      ) {
        reassigned = true;
        // A separate synchronous writer commits while abort's prepared patch yields.
        queueMicrotask(() => {
          replaceSessionEntrySync(
            { storePath: state.storePath, sessionKey: nextKey },
            { sessionId: "session-b", updatedAt: 200, chatType: "group", delivery },
          );
        });
      }
      return current?.sessionKey === sessionKey;
    };
    state.params.opts = { isCommandTargetCurrent: state.isCommandTargetCurrent };
    const failure = await (
      pathKind === "fast" ? tryFastAbortFromMessage(state) : handleStopCommand(state.params, true)
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(operation.abortSignal.aborted).toBe(true);
    expect(reassigned).toBe(true);
    expect(getConversationSession(address)).toEqual({
      sessionKey: nextKey,
      sessionId: "session-b",
    });
    expect(loadSessionEntry({ storePath: state.storePath, sessionKey })?.abortedLastRun).not.toBe(
      true,
    );
    if (failure) {
      expect(failure).toMatchObject({
        message: "The selected session changed before it could be stopped.",
      });
    }
    operation.complete();
  });

  it.each(["session", "writer", "prepared writer"] as const)(
    "skips stale abort bookkeeping after waiting for a replacement %s",
    async (replacement) => {
      const state = await setupStop();
      if (replacement === "prepared writer") {
        const current = await captureSessionEntryCurrentCheck({
          agentId: "main",
          storePath: state.storePath,
          sessionKey,
          matchGeneration: false,
        });
        state.isCommandTargetCurrent = current.isCurrent;
        state.params.opts = { isCommandTargetCurrent: current.isCurrent };
      }
      const entered = createDeferred();
      const release = createDeferred();
      const nextOwner =
        replacement === "session"
          ? { sessionId: "session-b" }
          : { activeWriterRunId: "later-writer", lifecycleRunId: "later-writer" };
      const writer = patchSessionEntryCore(
        { storePath: state.storePath, sessionKey, agentId: "main" },
        async () => {
          entered.resolve();
          await release.promise;
          return { ...nextOwner, updatedAt: Date.now() };
        },
      );
      await entered.promise;
      const operation = createReplyOperation({
        sessionKey,
        sessionId: "session-a",
        resetTriggered: false,
      });
      operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
      const aborted = createDeferred();
      const onAbort = () => aborted.resolve();
      operation.abortSignal.addEventListener("abort", onAbort, { once: true });
      const stopping =
        pathKind === "fast"
          ? tryFastAbortFromMessage(state)
          : handleStopCommand(state.params, true);
      onTestFinished(async () => {
        operation.abortSignal.removeEventListener("abort", onAbort);
        release.resolve();
        await Promise.allSettled([writer, stopping]);
        operation.complete();
      });
      void stopping.then(
        () => {
          if (!operation.abortSignal.aborted) {
            aborted.reject(new Error("Stop completed without aborting the active operation"));
          }
        },
        (error: unknown) => aborted.reject(error),
      );
      await aborted.promise;
      expect(operation.abortSignal.aborted).toBe(true);
      release.resolve();
      expect(await writer).toMatchObject(nextOwner);
      await stopping;
      expect(loadSessionEntry({ storePath: state.storePath, sessionKey })).toMatchObject(nextOwner);
      expect(loadSessionEntry({ storePath: state.storePath, sessionKey })?.abortedLastRun).not.toBe(
        true,
      );
    },
  );

  it("completes cancellation when its own abort releases the live publisher", async () => {
    const state = await setupStop();
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "session-a",
      resetTriggered: false,
    });
    operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
    state.isCommandTargetCurrent = () => !operation.abortSignal.aborted;
    state.params.opts = { isCommandTargetCurrent: state.isCommandTargetCurrent };
    const result = await (pathKind === "fast"
      ? tryFastAbortFromMessage(state)
      : handleStopCommand(state.params, true));
    expect(operation.abortSignal.aborted).toBe(true);
    expect(result).toMatchObject(
      pathKind === "fast" ? { handled: true, aborted: true } : { shouldContinue: false },
    );
    expect(
      loadSessionEntry({ storePath: state.storePath, sessionKey })?.abortedLastRun,
    ).toBeUndefined();
    operation.complete();
  });

  it("preserves a replacement run and its queued input after dispatch handoff", async () => {
    const state = await setupStop();
    const admitted = createReplyOperation({
      sessionKey,
      sessionId: "session-a",
      resetTriggered: false,
    });
    const dispatch = createDeferred();
    expect(state.isCommandTargetCurrent()).toBe(true);
    const pending = dispatch.promise.then(async () =>
      pathKind === "fast" ? tryFastAbortFromMessage(state) : handleStopCommand(state.params, true),
    );
    admitted.complete();
    await replaceSessionEntry(
      { storePath: state.storePath, sessionKey },
      {
        sessionId: "session-b",
        updatedAt: Date.now(),
      },
    );
    const replacement = createReplyOperation({
      sessionKey,
      sessionId: "session-b",
      resetTriggered: false,
    });
    replacement.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
    enqueueFollowupRun(
      sessionKey,
      createQueueTestRun({ prompt: "next conversation" }),
      { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
      "none",
    );
    dispatch.resolve();
    const result = await pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(replacement.abortSignal.aborted).toBe(false);
    expect(result).toBeInstanceOf(Error);
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
    expect(
      loadSessionEntry({ storePath: state.storePath, sessionKey })?.abortedLastRun,
    ).toBeUndefined();
    replacement.complete();
  });
});
