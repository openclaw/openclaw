import "../../test-utils/prepare-compiled-subprocesses.js";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import * as inProcessGateway from "../../agents/tools/in-process-gateway.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  loadSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as sessionLifecycleProjection from "../../config/sessions/session-lifecycle-projection.js";
import { SessionEntryLifecycleUpsertConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { restartHandlers } from "../../gateway/server-methods/restart.js";
import type { GatewayRequestHandlerOptions } from "../../gateway/server-methods/types.js";
import { createGatewayHookDispatcher } from "../../gateway/server/hooks.js";
import * as restartCoordinator from "../../infra/restart-coordinator.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueRequiredSystemEventEntry,
  peekDeliverableSystemEventEntries,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  recordSessionStateEventAsync,
  registerSessionStateWatch,
} from "../../sessions/session-state-events.js";
import { readCursor } from "../../sessions/session-state-events.test-support.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as routedReplies from "./route-reply.js";
import * as sessionEventHandoff from "./session-event-handoff.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
import {
  configureEventState,
  openEventToolHost,
  runEventFixture,
  startEmbeddedTurn,
} from "./session-event.test-support.js";
// mock-isolation: Use synthetic model execution with real admission and native filesystem guards.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: vi.fn(),
}));
const runIsolatedHook = vi.hoisted(() =>
  vi.fn<typeof import("../../cron/isolated-agent.js").runCronIsolatedAgentTurn>(),
);
// mock-isolation: Replace only the isolated hook model; terminal admission uses the real dispatcher.
vi.mock("../../cron/isolated-agent.js", () => ({ runCronIsolatedAgentTurn: runIsolatedHook }));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
// Match Gateway startup: activate the real reply runtimes before timing turn authority.
await Promise.all([
  import("../dispatch.js"),
  import("./get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

type EventReceipt = ReturnType<typeof enqueueSessionEventForHost>;
function observeEnqueue(source: string | undefined, onReceipt: (receipt: EventReceipt) => void) {
  const enqueue = sessionEventHandoff.enqueueSessionEventForHost;
  return vi
    .spyOn(sessionEventHandoff, "enqueueSessionEventForHost")
    .mockImplementation((text, options) => {
      const receipt = enqueue(text, options);
      if (source === undefined || options.source === source) {
        onReceipt(receipt);
      }
      return receipt;
    });
}

async function recordWatchEvents(child: string, sessionId: string) {
  const input = {
    sessionKey: child,
    sessionId,
    agentId: "main",
    kind: "human_direct_message" as const,
    actorType: "human" as const,
    summary: "Other actor changed the watched session",
    watcherSessionKeys: [],
  };
  return {
    child,
    frozen: expectDefined(await recordSessionStateEventAsync(input), "frozen event"),
    newer: expectDefined(await recordSessionStateEventAsync(input), "newer event"),
  };
}

async function enqueueGuardedCliWatchdog(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  sessionKey: string;
  entry: SessionEntry;
  signal: AbortSignal;
}) {
  const { prepareSystemAgentRunAdmission } = await import("../../agents/admitted-run-context.js");
  const { testing: cliBackends } = await import("../../agents/cli-backends.test-support.js");
  const { prepareCliRunContext } = await import("../../agents/cli-runner/prepare.js");
  const { runPreparedCliAgent } = await import("../../agents/cli-runner.js");
  const processSupervisor = await import("../../process/supervisor/index.js");
  const { resolveSessionFilePathCore, resolveSessionFilePathOptions, resolveSessionStorePathCore } =
    await import("../../config/sessions/paths.js");
  const sessionTarget = {
    agentId: "main",
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    storePath: resolveSessionStorePathCore(params.config.session?.store, { agentId: "main" }),
  };
  const runId = "guarded-cli-watchdog";
  const admission = prepareSystemAgentRunAdmission(params.config, runId, "main", "watchdog-proof");
  cliBackends.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        id: "watchdog-cli",
        pluginId: "watchdog-proof",
        nativeToolMode: "selectable",
        toolAvailabilityEnforcement: "execution-args",
        resolveExecutionArgs: ({ baseArgs }) => baseArgs,
        config: {
          command: process.execPath,
          args: [],
          output: "text",
          input: "arg",
          sessionMode: "none",
        },
      },
    ],
  });
  let receipt: ReturnType<typeof enqueueSessionEventForHost> | undefined;
  const observer = observeEnqueue(undefined, (value) => {
    receipt = value;
  });
  const supervisor = vi.spyOn(processSupervisor, "getProcessSupervisor").mockReturnValue({
    acquireScopeCleanup: () => async () => {},
    spawn: async () => ({
      runId,
      startedAtMs: Date.now(),
      activity: { resultSettled: true, lastOutputAtMs: Date.now() },
      cancel: () => {},
      wait: async () => ({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 1,
        stdout: "partial progress before stall",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    }),
    cancel: () => {},
    cancelScope: () => {},
  });
  try {
    const context = await prepareCliRunContext({
      preparedRunAdmission: admission,
      config: params.config,
      agentId: "main",
      sessionId: params.entry.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: resolveSessionFilePathCore(
        params.entry.sessionId,
        params.entry,
        resolveSessionFilePathOptions(sessionTarget),
      ),
      sessionTarget,
      sessionEntry: { ...params.entry, permissionMode: "guarded" },
      workspaceDir: params.workspaceDir,
      cwd: params.workspaceDir,
      skillsSnapshot: { prompt: "", skills: [] },
      toolsAllow: ["read"],
      sourceReplyDeliveryMode: "message_tool_only",
      provider: "watchdog-cli",
      model: "synthetic-watchdog-model",
      prompt: "Read the completion status.",
      timeoutMs: 180_000,
      runId,
      abortSignal: params.signal,
    });
    await expect(runPreparedCliAgent(context)).rejects.toThrow("produced no output");
    return expectDefined(receipt, "ordinary watchdog occurrence");
  } finally {
    observer.mockRestore();
    supervisor.mockRestore();
    cliBackends.resetDepsForTest();
    admission.close();
  }
}

it.for([
  { entry: { archivedAt: 1 }, error: "archived", retryable: false },
  { entry: { initializationPending: true }, error: "still initializing", retryable: true },
] satisfies Array<{ entry: Partial<InternalSessionEntry>; error: string; retryable: boolean }>)(
  "preserves session event admission policy: $error",
  async ({ entry, error, retryable }, { signal }) => {
    await withOpenClawTestState({ label: "session-event-refusal" }, async (state) => {
      await configureEventState(state, {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
      });
      const scope = { agentId: "main", sessionKey: "agent:main:event-refusal" };
      await replaceSessionEntry(scope, { sessionId: "event-refusal", updatedAt: 1, ...entry });
      runEmbeddedAgentMock.mockReset();
      const receipt = enqueueSessionEventForHost("Resume interrupted work", {
        ...scope,
        source: "restart",
        abortSignal: signal,
      });
      await expect(receipt.settled).resolves.toMatchObject({
        status: "failed",
        executionStarted: false,
        delivered: false,
        error: expect.stringContaining(error),
        retryable,
      });
      await expect(receipt.accepted).resolves.toMatchObject({ ok: false });
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
    });
  },
);

it.for([
  "new-session",
  "creation-retry",
  "cancelled-creation",
  "downgrade",
  "upgrade",
  "retained-tool-downgrade",
  "retained-overrides-downgrade",
  "retained-database-replacement",
  "retained-config-downgrade",
  "remapped-workspace",
  "remapped-guarded",
  "remapped-default",
  "failed-adoption",
  "tool-only-delivery",
  "cli-watchdog-guarded",
] as const)(
  "bounds a production background completion by current and retained permissions: %s",
  async (change, { signal, onTestFinished, skip }) => {
    if (change === "retained-database-replacement" && process.platform === "win32") {
      skip("Windows cannot replace an open database file");
    }
    await runEventFixture("session-event-permissions", onTestFinished, async (state) => {
      const config = await configureEventState(state, {
        tools: { profile: "coding", codeMode: false, toolSearch: false },
      });
      await fs.mkdir(state.workspaceDir, { recursive: true });
      const filePath = path.join(state.workspaceDir, "completion.txt");
      await fs.writeFile(filePath, "original\n");
      const scope = { agentId: "main", sessionKey: "agent:main:permission-completion" };
      const sessionId = "permission-completion";
      const lifecycleRevision = "same-generation";
      const setMode = async (permissionMode: SessionEntry["permissionMode"]) =>
        replaceSessionEntry(scope, {
          ...loadSessionEntry(scope),
          sessionId,
          lifecycleRevision,
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
          permissionMode,
        });
      const fresh = ["new-session", "creation-retry", "cancelled-creation"].includes(change);
      if (!fresh) {
        await setMode(change === "upgrade" ? "read-only" : "full");
      }
      const remapped = change.startsWith("remapped-");
      const toolOnly = change === "tool-only-delivery";
      const producerMode = toolOnly
        ? "full"
        : change === "remapped-workspace"
          ? "workspace"
          : change === "remapped-guarded"
            ? "guarded"
            : undefined;
      const capture = () => captureSessionEventTargetForHost(scope.agentId, scope.sessionKey);
      const target =
        remapped || toolOnly
          ? await withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: "agent:main:background-origin",
                sessionEventSettings: { permissionMode: producerMode },
                ...(toolOnly ? { sessionEventDelivery: false as const } : {}),
                sessionEventToolsAllow: ["read", "write"],
                receiptAuthority: () => true,
              },
              capture,
            )
          : await capture();
      if (fresh) {
        expect(target.sessionId).toBe("");
      }
      if (change === "downgrade" || change === "upgrade") {
        await setMode(change === "downgrade" ? "read-only" : "full");
      }
      let attempted = false;
      let observedMode: SessionEntry["permissionMode"];
      let retainedWriteRejected = false;
      const retainedDowngrade = change.startsWith("retained-");
      runEmbeddedAgentMock
        .mockReset()
        .mockImplementation(async (params: RunEmbeddedAgentParams) => {
          const { tools, close } = await openEventToolHost(params, "ordinary reply admission");
          let restoreDatabase: (() => void) | undefined;
          try {
            observedMode = params.permissionMode;
            const read = expectDefined(
              tools.find((tool) => tool.name === "read"),
              "read tool",
            );
            await read.execute("read-completion", { path: filePath });
            const write = tools.find((tool) => tool.name === "write");
            if (retainedDowngrade) {
              expect(write).toBeDefined();
              if (change === "retained-tool-downgrade") {
                await setMode("read-only");
              } else if (change === "retained-overrides-downgrade") {
                await updateSessionEntry(scope, () => ({ toolOverrides: { webSearch: false } }));
              } else if (change === "retained-database-replacement") {
                const database = openOpenClawAgentDatabase({ agentId: scope.agentId });
                const foreignPath = `${database.path}.foreign.sqlite`;
                const originalPath = `${database.path}.original`;
                openOpenClawAgentDatabase({
                  agentId: scope.agentId,
                  path: foreignPath,
                });
                replaceSessionEntrySync(
                  { ...scope, storePath: foreignPath },
                  {
                    ...expectDefined(loadSessionEntry(scope), "retained session"),
                    label: "foreign owner",
                  },
                );
                fsSync.renameSync(database.path, originalPath);
                fsSync.renameSync(foreignPath, database.path);
                restoreDatabase = () => {
                  fsSync.renameSync(database.path, foreignPath);
                  fsSync.renameSync(originalPath, database.path);
                };
              } else {
                config.tools = { ...config.tools, deny: ["write"] };
                setRuntimeConfigSnapshot(config);
              }
            }
            if (write) {
              attempted = true;
              try {
                await write.execute("write-completion", {
                  path: filePath,
                  content: "completed\n",
                });
                if (remapped && producerMode) {
                  await expect(
                    write.execute("write-outside-origin", {
                      path: state.path("outside-completion.txt"),
                      content: "escaped\n",
                    }),
                  ).rejects.toThrow(/outside|workspace|access|root/i);
                }
              } catch (error) {
                if (!retainedDowngrade) {
                  throw error;
                }
                expect(String(error)).toMatch(/authority|permission|active|configuration changed/i);
                retainedWriteRejected = true;
              }
            }
            return { payloads: [{ text: "Completion observed" }], meta: { durationMs: 1 } };
          } finally {
            restoreDatabase?.();
            close();
          }
        });
      let creationConflictObserved = false;
      const cancellation = new AbortController();
      let creationCancellationObserved = false;
      const commitProjection = sessionLifecycleProjection.commitSessionLifecycleProjectionInWorker;
      const creationCommit =
        change === "cancelled-creation" || change === "creation-retry"
          ? vi
              .spyOn(sessionLifecycleProjection, "commitSessionLifecycleProjectionInWorker")
              .mockImplementation(async (params) => {
                const creating = params.input.projected.upsertedEntries.some(
                  (entry) => entry.sessionKey === scope.sessionKey && !entry.expectedEntry,
                );
                if (creating && change === "creation-retry" && !creationConflictObserved) {
                  creationConflictObserved = true;
                  throw new SessionEntryLifecycleUpsertConflictError(scope.sessionKey);
                }
                const result = await commitProjection(params);
                if (creating && change === "cancelled-creation") {
                  creationCancellationObserved = true;
                  cancellation.abort();
                }
                return result;
              })
          : undefined;
      let outcome: Awaited<ReturnType<typeof enqueueSessionEventForHost>["settled"]>;
      let accepted: Awaited<ReturnType<typeof enqueueSessionEventForHost>["accepted"]>;
      const route = toolOnly
        ? vi
            .spyOn(routedReplies, "routePreparedReply")
            .mockResolvedValue({ ok: true, delivered: true })
        : undefined;
      try {
        const text = "Process the event; record the result.";
        const occurrence =
          change === "failed-adoption"
            ? expectDefined(
                enqueueRequiredSystemEventEntry(text, { sessionKey: scope.sessionKey }),
                "passive occurrence",
              )
            : undefined;
        const receipt =
          change === "cli-watchdog-guarded"
            ? await enqueueGuardedCliWatchdog({
                config,
                workspaceDir: state.workspaceDir,
                sessionKey: scope.sessionKey,
                entry: expectDefined(loadSessionEntry(scope), "full-permission destination"),
                signal,
              })
            : enqueueSessionEventForHost(text, {
                ...scope,
                source: fresh ? "plugin" : "exec",
                abortSignal: AbortSignal.any([signal, cancellation.signal]),
                expectedTarget: target,
                createIfMissing: fresh ? true : undefined,
                deliver: toolOnly ? undefined : false,
                ...(toolOnly
                  ? { deliveryContext: { channel: "telegram", to: "synthetic-tool-only-target" } }
                  : {}),
                ...(occurrence
                  ? {
                      occurrences: [occurrence],
                      preserveOccurrenceOnRejection: true as const,
                      onAdopted: () => {
                        throw new Error("Producer attempt failed after adoption");
                      },
                    }
                  : {}),
              });
        accepted = await receipt.accepted;
        outcome = await receipt.settled;
        if (route) {
          expect(outcome).toMatchObject({
            status: "completed",
            executionStarted: true,
            delivered: false,
          });
          expect(route).not.toHaveBeenCalled();
        }
      } finally {
        route?.mockRestore();
        creationCommit?.mockRestore();
      }
      if (["failed-adoption", "creation-retry", "cancelled-creation"].includes(change)) {
        expect(accepted).toMatchObject({ ok: false });
        expect(outcome).toMatchObject({
          status: change === "cancelled-creation" ? "cancelled" : "failed",
          executionStarted: false,
        });
        expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
        expect(await fs.readFile(filePath, "utf8")).toBe("original\n");
        if (change === "failed-adoption") {
          expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
        } else if (change === "creation-retry") {
          expect(creationConflictObserved).toBe(true);
          expect(outcome.error).toContain("retry against the current session");
          expect(loadSessionEntry(scope)).toBeUndefined();
        } else {
          expect({
            observed: creationCancellationObserved,
            aborted: cancellation.signal.aborted,
          }).toEqual({ observed: true, aborted: true });
          expect(outcome.delivered).toBe(false);
          expect(target.sessionId).not.toBe("");
          expect(loadSessionEntry(scope)).toMatchObject({
            sessionId: target.sessionId,
            lifecycleRevision: target.lifecycleRevision,
          });
        }
        return;
      }
      expect(accepted).toEqual({ ok: true });
      const evidence = JSON.stringify(outcome);
      expect(await fs.readFile(filePath, "utf8"), evidence).toBe(
        change === "new-session" || remapped || toolOnly ? "completed\n" : "original\n",
      );
      expect(runEmbeddedAgentMock, evidence).toHaveBeenCalledOnce();
      expect(observedMode, evidence).toBe(
        change === "downgrade" || change === "upgrade"
          ? "read-only"
          : change === "cli-watchdog-guarded"
            ? "guarded"
            : remapped
              ? producerMode
              : change === "new-session"
                ? undefined
                : "full",
      );
      expect(attempted, evidence).toBe(
        change === "new-session" || retainedDowngrade || remapped || toolOnly,
      );
      expect(retainedWriteRejected).toBe(retainedDowngrade);
      if (change === "new-session") {
        expect(loadSessionEntry(scope)?.sessionId).toBe(target.sessionId);
      } else {
        expect(loadSessionEntry(scope)).toMatchObject({ sessionId, lifecycleRevision });
      }
      if (retainedDowngrade) {
        expect(loadSessionEntry(scope)?.permissionMode).toBe(
          change === "retained-tool-downgrade" ? "read-only" : "full",
        );
        expect(outcome.executionStarted).toBe(true);
      } else {
        expect(outcome.status, outcome.error).toBe("completed");
      }
    });
  },
);

it.for([
  { watchCount: 1, cancellation: "none" },
  { watchCount: 2, cancellation: "none" },
  { watchCount: 2, cancellation: "all" },
  { watchCount: 2, cancellation: "request" },
])(
  "batches $watchCount watched sessions after FIFO adoption (cancellation: $cancellation)",
  async ({ watchCount, cancellation }, { signal }) => {
    const cancelledBatch = cancellation === "all" || cancellation === "request";
    await withOpenClawTestState(
      { label: "session-event-notice-adoption", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        await configureEventState(state, {
          messages: { queue: { cap: watchCount, drop: "new" } },
        });
        const scope = { agentId: "main", sessionKey: "agent:main:notice-watcher" };
        await replaceSessionEntry(scope, {
          sessionId: "notice-watcher",
          lifecycleRevision: "original",
          permissionMode: "full",
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
        });
        const child = "agent:main:notice-child";
        const sibling = "agent:main:notice-sibling";
        for (const targetSessionKey of [child, sibling].slice(0, watchCount)) {
          expect(
            await registerSessionStateWatch({
              watcherSessionKey: scope.sessionKey,
              targetSessionKey,
            }),
          ).toBe(true);
        }
        const firstStarted = createDeferred();
        const releaseFirst = createDeferred();
        const starts: string[] = [];
        runEmbeddedAgentMock
          .mockReset()
          .mockImplementation(async (params: RunEmbeddedAgentParams) => {
            await startEmbeddedTurn(params, "normal reply admission");
            starts.push(params.prompt);
            if (starts.length === 1) {
              firstStarted.resolve();
              await releaseFirst.promise;
            }
            return { payloads: [{ text: "Observed" }], meta: { durationMs: 1 } };
          });
        const target = await captureSessionEventTargetForHost(scope.agentId, scope.sessionKey);
        const first = enqueueSessionEventForHost("First admitted work", {
          ...scope,
          source: "task",
          expectedTarget: target,
          abortSignal: signal,
          deliver: false,
        });
        const captured = createDeferred();
        const firstNoticeCaptured = createDeferred();
        const enqueued = createDeferred();
        const notices: EventReceipt[] = [];
        let captures = 0;
        const capture = sessionEventHandoff.captureSessionEventTargetForHost;
        const captureSpy = vi
          .spyOn(sessionEventHandoff, "captureSessionEventTargetForHost")
          .mockImplementation(async (...args) => {
            const result = await capture(...args);
            if (++captures === 1) {
              firstNoticeCaptured.resolve();
            }
            if (captures === watchCount) {
              captured.resolve();
            }
            return result;
          });
        const enqueueSpy = observeEnqueue("session", (receipt) => {
          notices.push(receipt);
          enqueued.resolve();
        });
        try {
          await expect(first.accepted).resolves.toEqual({ ok: true });
          await withinTest(firstStarted.promise, signal);
          // Advance notice timers without moving mailbox enqueue timestamps into the future.
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          const observed = [await recordWatchEvents(child, "notice-child")];
          const assertCursor = (notice: (typeof observed)[number], consumed = false) => {
            expect(
              readCursor(
                { env: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir } },
                scope.sessionKey,
                notice.child,
              ),
            ).toEqual({
              last_seen_sequence: consumed ? notice.frozen.sequence : 0,
              notified_sequence: consumed ? notice.newer.sequence : notice.frozen.sequence,
              material_sequence: notice.newer.sequence,
            });
          };
          if (watchCount === 2) {
            await withinTest(firstNoticeCaptured.promise, signal);
            await updateSessionEntry(scope, () => ({ permissionMode: "read-only" }));
            observed.push(await recordWatchEvents(sibling, "notice-sibling"));
          }
          await withinTest(captured.promise, signal);
          await updateSessionEntry(scope, () => ({ permissionMode: "full" }));
          await vi.advanceTimersByTimeAsync(20_000);
          await withinTest(enqueued.promise, signal);
          for (const notice of notices) {
            await expect(notice.accepted).resolves.toEqual({ ok: true });
          }
          expect(starts).toHaveLength(1);
          if (cancelledBatch) {
            const originals = peekSystemEventEntries(scope.sessionKey);
            if (cancellation === "all") {
              consumeSelectedSystemEventEntries(scope.sessionKey, originals);
            } else {
              expect(notices[0]!.cancel()).toBe(true);
            }
            await expect(notices[0]!.settled).resolves.toMatchObject({
              status: "cancelled",
              executionStarted: false,
            });
            expect(notices).toHaveLength(1);
            expect(peekSystemEventEntries(scope.sessionKey)).toEqual(
              cancellation === "all" ? [] : originals,
            );
          }
          if (watchCount === 1) {
            const retainedOverflow = expectDefined(
              enqueueRequiredSystemEventEntry("Overflow retained hook", {
                sessionKey: scope.sessionKey,
              }),
              "retained overflow occurrence",
            );
            const rejected = enqueueSessionEventForHost(retainedOverflow.text, {
              ...scope,
              source: "hook",
              expectedTarget: target,
              occurrences: [retainedOverflow],
              preserveOccurrenceOnRejection: true,
            });
            await expect(rejected.accepted).resolves.toMatchObject({ ok: false });
            await expect(rejected.settled).resolves.toMatchObject({
              status: "failed",
              executionStarted: false,
            });
            expect(peekDeliverableSystemEventEntries(scope.sessionKey)).toContainEqual(
              retainedOverflow,
            );
          }
          observed.forEach((notice) => assertCursor(notice));
          // Subsequent queue execution uses real time; only the notice coalescing window was advanced.
          vi.useRealTimers();
          releaseFirst.resolve();
          await expect(first.settled).resolves.toMatchObject({ status: "completed" });
          for (const notice of cancelledBatch ? [] : notices) {
            const outcome = await notice.settled;
            expect(outcome, outcome.error).toMatchObject({
              status: "completed",
              executionStarted: true,
            });
          }
          expect(starts).toHaveLength(cancelledBatch ? 1 : 2);
          if (!cancelledBatch) {
            expect(runEmbeddedAgentMock.mock.calls[1]?.[0].permissionMode).toBe(
              watchCount === 2 ? "read-only" : "full",
            );
          }
          expect(starts[0]).toContain("First admitted work");
          for (const noticeState of observed) {
            if (cancelledBatch) {
              expect(starts[1] ?? "").not.toContain(`Session "${noticeState.child}" changed`);
            } else {
              expect(starts[1]).toContain(`Session "${noticeState.child}" changed`);
            }
            assertCursor(noticeState, !cancelledBatch);
            expect(
              peekSystemEventEntries(scope.sessionKey).some(
                (event) =>
                  event.text.includes(`Session "${noticeState.child}" changed`) &&
                  event.text.includes(`changesSince ${noticeState.frozen.sequence}`),
              ),
            ).toBe(!cancelledBatch);
          }
        } finally {
          vi.useRealTimers();
          releaseFirst.resolve();
          await Promise.allSettled([first.settled, ...notices.map((notice) => notice.settled)]);
          captureSpy.mockRestore();
          enqueueSpy.mockRestore();
          await drainGlobalSingletonLifecycleState("restart");
          resetSystemEventsForTest();
        }
      },
    );
  },
);

it.for([
  { global: false, result: "ok" as const },
  { global: true, result: "error" as const },
])(
  "creates the unused terminal receiver for an immediate hook ($global, $result)",
  async (row, { signal, onTestFinished }) => {
    await runEventFixture("hook-terminal-first-use", onTestFinished, async (state) => {
      await configureEventState(state, row.global ? { session: { scope: "global" } } : {});
      const scope = { agentId: "main", sessionKey: row.global ? "global" : "agent:main:main" };
      expect(loadSessionEntry(scope)).toBeUndefined();
      const summary = row.result === "ok" ? "Mailbox update is ready" : "Mailbox connection failed";
      runIsolatedHook.mockReset().mockImplementation(async (params) => {
        params.onExecutionStarted?.();
        return {
          status: row.result,
          summary,
          executionStarted: true,
          delivered: false,
          deliveryAttempted: false,
        };
      });
      runEmbeddedAgentMock
        .mockReset()
        .mockImplementation(async (params: RunEmbeddedAgentParams) => {
          await startEmbeddedTurn(params, "ordinary terminal admission");
          return { payloads: [{ text: "Terminal event observed" }], meta: { durationMs: 1 } };
        });
      const enqueued = createDeferred<EventReceipt>();
      const observer = observeEnqueue("hook", (receipt) => enqueued.resolve(receipt));
      let terminal: EventReceipt | undefined;
      try {
        const hooks = createGatewayHookDispatcher({
          deps: {},
          logHooks: createSubsystemLogger("test/hook-terminal"),
        });
        const admitted = await hooks.dispatchAgentHook({
          name: "Mailbox",
          message: "Check the mailbox",
          effectiveAgentId: "main",
          sessionKey: "hook:terminal-first-use",
          sessionMode: "isolated",
          sourcePath: "/hooks/agent",
          wakeMode: "now",
          deliver: true,
          channel: "last",
          delivery: { mode: "announce", channel: "last" },
        });
        expect(admitted).toMatchObject({ ok: true });
        if (!admitted.ok) {
          throw new Error(admitted.error);
        }
        await expect(admitted.completion).resolves.toMatchObject({ status: row.result });
        terminal = await withinTest(enqueued.promise, signal);
        await expect(terminal.accepted).resolves.toEqual({ ok: true });
        await expect(terminal.settled).resolves.toMatchObject({
          status: "completed",
          executionStarted: true,
        });
        const created = expectDefined(loadSessionEntry(scope), "created terminal receiver");
        expect(created.sessionId).not.toBe("");
        expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
        const turn = expectDefined(runEmbeddedAgentMock.mock.calls[0]?.[0], "ordinary event turn");
        expect(turn).toMatchObject({ sessionId: created.sessionId, trigger: "event" });
        expect(turn.prompt).toContain(summary);
      } finally {
        await Promise.allSettled([terminal?.settled]);
        observer.mockRestore();
        resetSystemEventsForTest();
      }
    });
  },
);

const ownerRequesterOutcomes = {
  owner: { owner: true, restart: { ok: true }, requester: "456", scheduled: 1 },
  guest: { owner: false, restart: { gated: true }, requester: undefined, scheduled: 0 },
  "revoked-before-admission": { owner: false, restart: { gated: true }, scheduled: 0 },
  // Revoking publishes config, which retires the admitted turn's tool host before the call.
  "revoked-after-admission": {
    owner: true,
    restart: "agent harness host capability is no longer active",
    scheduled: 0,
  },
};

it.for(Object.keys(ownerRequesterOutcomes) as Array<keyof typeof ownerRequesterOutcomes>)(
  "runs an owner-only tool from a background completion only for its current owner requester: %s",
  async (requester, { signal, onTestFinished }) => {
    await runEventFixture("session-event-owner-requester", onTestFinished, async (state) => {
      const config = await configureEventState(state, {
        channels: { telegram: {} },
        commands: { ownerAllowFrom: ["456"] },
      });
      const revoke = () =>
        setRuntimeConfigSnapshot({ ...config, commands: { ownerAllowFrom: ["789"] } });
      const scope = { agentId: "main", sessionKey: "agent:main:owner-requester" };
      await replaceSessionEntry(scope, { sessionId: "owner-requester", updatedAt: Date.now() });
      // The host-owned exec caller supplies the requester; the producer only asks to retain it.
      const senderId = requester === "guest" ? "789" : "456";
      const target = await withGatewayToolCallerIdentity(
        { ...scope, requesterOrigin: { ...scope, messageProvider: "telegram", senderId } },
        () =>
          captureSessionEventTargetForHost("main", scope.sessionKey, {
            retainRequesterOwner: true,
          }),
      );
      if (requester === "revoked-before-admission") {
        revoke();
      }
      // Only the Gateway transport and final scheduler are stubbed; the real restart handler
      // still rechecks the projected requester against current config.
      const scheduled = vi
        .spyOn(restartCoordinator, "scheduleSafeGatewayRestart")
        .mockReturnValue({ ok: true } as never);
      const gatewayContext = vi
        .spyOn(inProcessGateway, "getInProcessGatewayToolContext")
        .mockReturnValue({} as never);
      const gatewayCall = vi
        .spyOn(inProcessGateway, "callInProcessGatewayTool")
        .mockImplementation(async (method, params) => {
          let response: unknown;
          await restartHandlers[method]!({
            params,
            context: { getRuntimeConfig: () => getRuntimeConfigSnapshot()! },
            respond: (ok, value, error) => {
              if (!ok) {
                throw new Error(error?.message);
              }
              response = value;
            },
          } as GatewayRequestHandlerOptions);
          return response as never;
        });
      onTestFinished(() =>
        [scheduled, gatewayContext, gatewayCall].forEach((spy) => spy.mockRestore()),
      );
      let senderIsOwner: boolean | undefined;
      let restart: unknown;
      runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
        // The turn's assembled surface owns the owner-only gate for the model's call.
        const { tools, close } = await openEventToolHost(params, "completion admission", {
          includeOpenClawTools: true,
        });
        senderIsOwner = params.senderIsOwner;
        if (requester === "revoked-after-admission") {
          revoke();
        }
        restart = await tools
          .find((tool) => tool.name === "gateway")!
          .execute("owner-only-restart", { action: "restart" })
          .then(
            (result) => result.details,
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          )
          .finally(close);
        return { payloads: [{ text: "Completion observed" }], meta: { durationMs: 1 } };
      });
      const receipt = enqueueSessionEventForHost("Background command finished.", {
        ...scope,
        source: "exec",
        expectedTarget: target,
        abortSignal: signal,
        deliver: false,
        deliveryContext: { channel: "telegram", to: "456" },
      });
      await expect(receipt.settled).resolves.toMatchObject({ status: "completed" });
      expect({
        owner: senderIsOwner,
        restart,
        requester: (gatewayCall.mock.calls[0]?.[1] as { requester?: { senderId?: string } })
          ?.requester?.senderId,
        scheduled: scheduled.mock.calls.length,
      }).toEqual(ownerRequesterOutcomes[requester]);
    });
  },
);
