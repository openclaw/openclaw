import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  applyEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
} from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { buildEmbeddedAttemptToolRunContext } from "../../agents/embedded-agent-runner/run/attempt-tool-run-context.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { createAgentHarnessHostCapabilities } from "../../agents/harness/host-capability.js";
import { readToolAllowlistIntersection } from "../../agents/tool-policy-shared.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { resolveAttemptWorkspaceSandbox } from "../../agents/workspace-sandbox.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  loadSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as sessionLifecycleProjection from "../../config/sessions/session-lifecycle-projection.js";
import { registerSessionMaintenancePreserveKeysProvider } from "../../config/sessions/store-maintenance-preserve.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createGatewayHookDispatcher } from "../../gateway/server/hooks.js";
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
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as routedReplies from "./route-reply.js";
import * as sessionEventHandoff from "./session-event-handoff.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
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

function describeToolCap(allow: readonly string[] | undefined) {
  return { allow, intersections: allow ? readToolAllowlistIntersection(allow) : undefined };
}

async function enqueueGuardedCliWatchdog(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  sessionKey: string;
  entry: SessionEntry;
  signal: AbortSignal;
  diagnostic: Record<string, unknown>;
}) {
  const { prepareSystemAgentRunAdmission } = await import("../../agents/admitted-run-context.js");
  const { testing: cliBackends } = await import("../../agents/cli-backends.test-support.js");
  const { prepareCliRunContext } = await import("../../agents/cli-runner/prepare.js");
  const { runPreparedCliAgent } = await import("../../agents/cli-runner.js");
  const { executeDeps } = await import("../../agents/cli-runner/execute-deps.js");
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
  const enqueue = executeDeps.enqueueSessionEvent;
  const observer = vi.spyOn(executeDeps, "enqueueSessionEvent").mockImplementation((...args) => {
    params.diagnostic.target = {
      tools: describeToolCap(args[1].expectedTarget?.toolsAllow),
      settings: args[1].expectedTarget?.settings,
    };
    receipt = enqueue(...args);
    return receipt;
  });
  const supervisor = vi.spyOn(executeDeps, "getProcessSupervisor").mockReturnValue({
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
    params.diagnostic.prepared = {
      tools: describeToolCap(context.sessionEventSourcePolicy?.toolsAllow),
      settings: context.sessionEventSourcePolicy?.settings,
    };
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
  "allowed",
  "new-session",
  "creation-retry",
  "cancelled-creation",
  "downgrade",
  "upgrade",
  "retained-tool-downgrade",
  "retained-config-downgrade",
  "remapped-workspace",
  "remapped-guarded",
  "remapped-default",
  "failed-adoption",
  "tool-only-delivery",
  "cli-watchdog-guarded",
] as const)(
  "bounds a production background completion by current and retained permissions: %s",
  async (change, { signal, onTestFinished }) => {
    const fixtureWork = withOpenClawTestState(
      { label: "session-event-permissions", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: "mock-openai/gpt-5.6-luna" },
              models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
            },
          },
          tools: { profile: "coding", codeMode: false, toolSearch: false },
          skills: { load: { watch: false } },
          plugins: { enabled: false },
        };
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        // Gateway boot admits shared state before accepting events; the agent store stays cold.
        openOpenClawStateDatabase();
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
        const fresh =
          change === "new-session" ||
          change === "creation-retry" ||
          change === "cancelled-creation";
        if (!fresh) {
          await setMode(change === "upgrade" ? "read-only" : "full");
        }
        const remapped =
          change === "remapped-workspace" ||
          change === "remapped-guarded" ||
          change === "remapped-default";
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
        const diagnostic: Record<string, unknown> = {};
        let observedMode: SessionEntry["permissionMode"];
        let retainedWriteRejected = false;
        const retainedDowngrade =
          change === "retained-tool-downgrade" || change === "retained-config-downgrade";
        runEmbeddedAgentMock
          .mockReset()
          .mockImplementation(async (params: RunEmbeddedAgentParams) => {
            const admission = expectDefined(
              params.preparedRunAdmission,
              "ordinary reply admission",
            );
            const admittedRunContext = await admission.admit("gateway", params.runId);
            params.onExecutionPhase?.({ phase: "model_call_started" });
            await params.onExecutionStarted?.();
            await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
            const workspace = await resolveAttemptWorkspaceSandbox({
              ...params,
              admittedRunContext,
            });
            const host = createAgentHarnessHostCapabilities({
              attempt: {
                admittedRunContext,
                runId: params.runId,
                abortSignal: params.abortSignal,
                config: params.config,
                agentId: params.agentId,
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                sessionTarget: params.sessionTarget,
                permissionMode: params.permissionMode,
                requireWorkspaceOnly: params.requireWorkspaceOnly,
                sessionRoot: workspace.sessionPermissionRoot,
                workspaceDir: params.workspaceDir,
                bootstrapWorkspaceDir: params.bootstrapWorkspaceDir,
                cwd: params.cwd,
                sandboxAgentId: params.sandboxAgentId,
                skillsSnapshot: params.skillsSnapshot,
                toolExecutionAllow: params.toolExecutionAllow,
                toolsAllow: params.toolsAllow,
                runtimePluginToolGrant: params.runtimePluginToolGrant,
                trigger: params.trigger,
                approvalReviewerDeviceId: params.approvalReviewerDeviceId,
                messageChannel: params.messageChannel,
                messageProvider: params.messageProvider,
                messageTo: params.messageTo,
                currentMessagingTarget: params.currentMessagingTarget,
                currentChannelId: params.currentChannelId,
                currentThreadTs: params.currentThreadTs,
                agentAccountId: params.agentAccountId,
                senderId: params.senderId,
                senderIsOwner: params.senderIsOwner,
                memberRoleIds: params.memberRoleIds,
              },
              pluginId: "openclaw",
            });
            try {
              observedMode = params.permissionMode;
              const toolRunContext = buildEmbeddedAttemptToolRunContext({
                ...params,
                model:
                  params.provider && params.model
                    ? { provider: params.provider, id: params.model }
                    : undefined,
              });
              const construction = resolveEmbeddedAttemptToolConstructionPlan({
                toolsAllow: toolRunContext.runtimeToolAllowlist,
              });
              const boundTools = expectDefined(
                host.capabilities.createToolSurface,
                "managed tool surface",
              )({
                ...toolRunContext,
                config: params.config,
                agentId: params.agentId,
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                workspaceDir: workspace.effectiveWorkspace,
                cwd: workspace.effectiveCwd,
                sessionPermissionPolicy: workspace.sessionPermissionPolicy,
                toolConstructionPlan: {
                  ...construction.codingToolConstructionPlan,
                  includeShellTools: false,
                  includeChannelTools: false,
                  includeOpenClawTools: false,
                  includePluginTools: false,
                },
              });
              const tools = applyEmbeddedAttemptToolsAllow(
                boundTools,
                construction.runtimeToolAllowlist,
              );
              Object.assign(diagnostic, {
                model: { tools: describeToolCap(params.toolsAllow), mode: params.permissionMode },
                projection: describeToolCap(construction.runtimeToolAllowlist),
                constructedToolNames: boundTools.map((tool) => tool.name),
                finalToolNames: tools.map((tool) => tool.name),
              });
              const read = expectDefined(
                tools.find((tool) => tool.name === "read"),
                "read tool",
              );
              await read.execute("read-completion", { path: filePath });
              const write = tools.find((tool) => tool.name === "write");
              if (change === "retained-tool-downgrade") {
                expect(write).toBeDefined();
                await setMode("read-only");
              } else if (change === "retained-config-downgrade") {
                expect(write).toBeDefined();
                config.tools = { ...config.tools, deny: ["write"] };
                setRuntimeConfigSnapshot(config);
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
                  expect(String(error)).toMatch(
                    /authority|permission|active|configuration changed/i,
                  );
                  retainedWriteRejected = true;
                }
              }
              return { payloads: [{ text: "Completion observed" }], meta: { durationMs: 1 } };
            } finally {
              host.close();
            }
          });
        let maintenancePrepared = false;
        const cancellation = new AbortController();
        let creationCancellationObserved = false;
        const commitProjection =
          sessionLifecycleProjection.commitSessionLifecycleProjectionInWorker;
        const creationCommit =
          change === "cancelled-creation"
            ? vi
                .spyOn(sessionLifecycleProjection, "commitSessionLifecycleProjectionInWorker")
                .mockImplementation(async (params) => {
                  const result = await commitProjection(params);
                  if (
                    params.input.projected.upsertedEntries.some(
                      (entry) => entry.sessionKey === scope.sessionKey && !entry.expectedEntry,
                    )
                  ) {
                    creationCancellationObserved = true;
                    cancellation.abort();
                  }
                  return result;
                })
            : undefined;
        let stopPreserving = () => {};
        if (change === "creation-retry") {
          stopPreserving = registerSessionMaintenancePreserveKeysProvider(async () => {
            maintenancePrepared = true;
            stopPreserving();
            return { capture: () => [], dispose: () => {} };
          });
        }
        let outcome: Awaited<ReturnType<typeof enqueueSessionEventForHost>["settled"]>;
        let accepted: Awaited<ReturnType<typeof enqueueSessionEventForHost>["accepted"]>;
        const route = toolOnly
          ? vi.spyOn(routedReplies, "routeReply").mockResolvedValue({ ok: true, delivered: true })
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
                  diagnostic,
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
          stopPreserving();
        }
        if (change === "failed-adoption") {
          expect(accepted).toMatchObject({ ok: false });
          expect(outcome).toMatchObject({ status: "failed", executionStarted: false });
          expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
          expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
          expect(await fs.readFile(filePath, "utf8")).toBe("original\n");
          return;
        }
        if (change === "creation-retry") {
          expect(accepted).toMatchObject({ ok: false });
          expect(maintenancePrepared).toBe(true);
          expect(outcome).toMatchObject({
            status: "failed",
            executionStarted: false,
            error: expect.stringContaining("retry against the current session"),
          });
          expect(loadSessionEntry(scope)).toBeUndefined();
          expect(await fs.readFile(filePath, "utf8")).toBe("original\n");
          expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
          return;
        }
        if (change === "cancelled-creation") {
          expect(creationCancellationObserved).toBe(true);
          expect(cancellation.signal.aborted).toBe(true);
          expect(accepted).toMatchObject({ ok: false });
          expect(outcome).toMatchObject({
            status: "cancelled",
            executionStarted: false,
            delivered: false,
          });
          expect(target.sessionId).not.toBe("");
          expect(loadSessionEntry(scope)).toMatchObject({
            sessionId: target.sessionId,
            lifecycleRevision: target.lifecycleRevision,
          });
          expect(await fs.readFile(filePath, "utf8")).toBe("original\n");
          expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
          return;
        }
        expect(accepted).toEqual({ ok: true });
        const evidence = JSON.stringify({ outcome, diagnostic });
        expect(await fs.readFile(filePath, "utf8"), evidence).toBe(
          change === "allowed" || change === "new-session" || remapped || toolOnly
            ? "completed\n"
            : "original\n",
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
          change === "allowed" ||
            change === "new-session" ||
            retainedDowngrade ||
            remapped ||
            toolOnly,
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
      },
    );
    // A timed-out body still owns its state until cancellation and cleanup settle.
    onTestFinished(async () => {
      await Promise.allSettled([fixtureWork]);
    });
    await fixtureWork;
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
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: "mock-openai/gpt-5.6-luna" },
              models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
            },
          },
          messages: { queue: { cap: watchCount, drop: "new" } },
          plugins: { enabled: false },
          skills: { load: { watch: false } },
        };
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        openOpenClawStateDatabase();
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
            const admission = expectDefined(params.preparedRunAdmission, "normal reply admission");
            await admission.admit("gateway", params.runId);
            params.onExecutionPhase?.({ phase: "model_call_started" });
            await params.onExecutionStarted?.();
            await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
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
        const notices: Array<ReturnType<typeof enqueueSessionEventForHost>> = [];
        let captures = 0;
        const capture = sessionEventHandoff.captureSessionEventTargetForHost;
        const enqueue = sessionEventHandoff.enqueueSessionEventForHost;
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
        const enqueueSpy = vi
          .spyOn(sessionEventHandoff, "enqueueSessionEventForHost")
          .mockImplementation((text, options) => {
            const receipt = enqueue(text, options);
            if (options.source === "session") {
              notices.push(receipt);
              enqueued.resolve();
            }
            return receipt;
          });
        try {
          await expect(first.accepted).resolves.toEqual({ ok: true });
          await withinTest(firstStarted.promise, signal);
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
          const input = {
            sessionKey: child,
            sessionId: "notice-child",
            agentId: "main",
            kind: "human_direct_message" as const,
            actorType: "human" as const,
            summary: "Other actor changed the watched session",
            watcherSessionKeys: [],
          };
          const frozen = expectDefined(await recordSessionStateEventAsync(input), "frozen event");
          const newer = expectDefined(await recordSessionStateEventAsync(input), "newer event");
          const observed = [{ child, frozen, newer }];
          if (watchCount === 2) {
            await withinTest(firstNoticeCaptured.promise, signal);
            await updateSessionEntry(scope, () => ({ permissionMode: "read-only" }));
            const siblingInput = { ...input, sessionKey: sibling, sessionId: "notice-sibling" };
            const siblingFrozen = expectDefined(
              await recordSessionStateEventAsync(siblingInput),
              "sibling frozen event",
            );
            const siblingNewer = expectDefined(
              await recordSessionStateEventAsync(siblingInput),
              "sibling newer event",
            );
            observed.push({ child: sibling, frozen: siblingFrozen, newer: siblingNewer });
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
          expect(starts).toHaveLength(1);
          for (const noticeState of observed) {
            expect(
              readCursor(
                { env: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir } },
                scope.sessionKey,
                noticeState.child,
              ),
            ).toEqual({
              last_seen_sequence: 0,
              notified_sequence: noticeState.frozen.sequence,
              material_sequence: noticeState.newer.sequence,
            });
          }
          // Subsequent queue execution uses real time; only the notice coalescing window was advanced.
          vi.useRealTimers();
          releaseFirst.resolve();
          await expect(first.settled).resolves.toMatchObject({ status: "completed" });
          for (const notice of cancelledBatch ? [] : notices) {
            await expect(notice.settled).resolves.toMatchObject({
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
            const wasCancelled = cancelledBatch;
            if (wasCancelled) {
              expect(starts[1] ?? "").not.toContain(`Session "${noticeState.child}" changed`);
            } else {
              expect(starts[1]).toContain(`Session "${noticeState.child}" changed`);
            }
            expect(
              readCursor(
                { env: { ...state.env, OPENCLAW_STATE_DIR: state.stateDir } },
                scope.sessionKey,
                noticeState.child,
              ),
            ).toEqual({
              last_seen_sequence: wasCancelled ? 0 : noticeState.frozen.sequence,
              notified_sequence: wasCancelled
                ? noticeState.frozen.sequence
                : noticeState.newer.sequence,
              material_sequence: noticeState.newer.sequence,
            });
            expect(
              peekSystemEventEntries(scope.sessionKey).some(
                (event) =>
                  event.text.includes(`Session "${noticeState.child}" changed`) &&
                  event.text.includes(`changesSince ${noticeState.frozen.sequence}`),
              ),
            ).toBe(!wasCancelled);
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
    const fixtureWork = withOpenClawTestState(
      { label: "hook-terminal-first-use", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: "mock-openai/gpt-5.6-luna" },
              models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
            },
          },
          ...(row.global ? { session: { scope: "global" as const } } : {}),
          plugins: { enabled: false },
          skills: { load: { watch: false } },
        };
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        openOpenClawStateDatabase();
        const scope = { agentId: "main", sessionKey: row.global ? "global" : "agent:main:main" };
        expect(loadSessionEntry(scope)).toBeUndefined();
        const summary =
          row.result === "ok" ? "Mailbox update is ready" : "Mailbox connection failed";
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
            const admission = expectDefined(
              params.preparedRunAdmission,
              "ordinary terminal admission",
            );
            await admission.admit("gateway", params.runId);
            params.onExecutionPhase?.({ phase: "model_call_started" });
            await params.onExecutionStarted?.();
            await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
            return { payloads: [{ text: "Terminal event observed" }], meta: { durationMs: 1 } };
          });
        const enqueued = createDeferred<ReturnType<typeof enqueueSessionEventForHost>>();
        const enqueue = sessionEventHandoff.enqueueSessionEventForHost;
        const observer = vi
          .spyOn(sessionEventHandoff, "enqueueSessionEventForHost")
          .mockImplementation((text, options) => {
            const receipt = enqueue(text, options);
            if (options.source === "hook") {
              enqueued.resolve(receipt);
            }
            return receipt;
          });
        let terminal: ReturnType<typeof enqueueSessionEventForHost> | undefined;
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
          const turn = expectDefined(
            runEmbeddedAgentMock.mock.calls[0]?.[0],
            "ordinary event turn",
          );
          expect(turn.sessionId).toBe(created.sessionId);
          expect(turn.trigger).toBe("event");
          expect(turn.prompt).toContain(summary);
        } finally {
          await Promise.allSettled([terminal?.settled]);
          observer.mockRestore();
          resetSystemEventsForTest();
        }
      },
    );
    onTestFinished(async () => {
      await Promise.allSettled([fixtureWork]);
    });
    await fixtureWork;
  },
);
