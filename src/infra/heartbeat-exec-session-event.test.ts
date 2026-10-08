import "../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { heartbeatRunnerTelegramPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { waitForExecScope } from "../agents/bash-process-registry.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { createExecTool } from "../agents/bash-tools.exec-run.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import * as runtimePlugins from "../agents/runtime-plugins.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import * as routedReplies from "../auto-reply/reply/route-reply.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { runHeartbeatOnce } from "./heartbeat-runner-run.js";
import { seedHeartbeatScratchForTest } from "./heartbeat-runner.test-utils.js";
import { resetSystemEventsForTest } from "./system-events.js";

// mock-isolation: Replace model inference while retaining ordinary admission, tools, and delivery custody.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const model = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

function nodeCommand(source: string): string {
  const quote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const command = `${quote(process.execPath)} -e ${quote(source)}`;
  return process.platform === "win32" ? `& ${command}` : command;
}

it.for(["none", "alerts-disabled", "visible"] as const)(
  "retains periodic delivery policy through a real background exec: %s",
  async (policy, { signal, onTestFinished }) => {
    const fixtureWork = withOpenClawTestState(
      { label: "heartbeat-exec-delivery", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const visible = policy === "visible";
        const destination = "-1001234567890";
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: "mock-openai/gpt-5.6-luna" },
              models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
              heartbeat: {
                every: "5m",
                target: policy === "none" ? "none" : "telegram",
                to: destination,
                isolatedSession: false,
              },
            },
          },
          messages: { visibleReplies: "automatic" },
          channels: {
            telegram: { botToken: "test-token", allowFrom: ["*"] },
            defaults: { heartbeatVisibility: { showAlerts: policy !== "alerts-disabled" } },
          },
          plugins: { enabled: false },
          skills: { load: { watch: false } },
        };
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        openOpenClawStateDatabase();
        const scope = { agentId: "main", sessionKey: "agent:main:main" };
        await replaceSessionEntry(scope, {
          sessionId: "periodic-exec-session",
          lifecycleRevision: "original",
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
          permissionMode: "full",
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: destination },
          }),
        });
        await seedHeartbeatScratchForTest({ content: "- Run the background status check\n" });
        const previousRegistry = captureActivePluginRegistrySnapshot();
        const registry = createTestRegistry([
          { pluginId: "telegram", plugin: heartbeatRunnerTelegramPlugin, source: "test" },
        ]);
        setActivePluginRegistry(registry);
        const runtimeRegistry = vi
          .spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle")
          .mockReturnValue(registry);
        const sendHeartbeat = vi
          .fn()
          .mockResolvedValue({ messageId: "periodic-send", chatId: destination });
        const sendCompletion = vi
          .spyOn(routedReplies, "routeReply")
          .mockResolvedValue({ ok: true, delivered: true, messageId: "completion-send" });
        const completionCreated =
          createDeferred<ReturnType<typeof sessionEvents.enqueueSessionEventForHost>>();
        const enqueue = sessionEvents.enqueueSessionEventForHost;
        const observeCompletion = vi
          .spyOn(sessionEvents, "enqueueSessionEventForHost")
          .mockImplementation((text, options) => {
            const receipt = enqueue(text, options);
            if (options.source === "exec") {
              completionCreated.resolve(receipt);
            }
            return receipt;
          });
        model.mockReset().mockImplementation(async (params: RunEmbeddedAgentParams) => {
          const admission = expectDefined(params.preparedRunAdmission, "real turn admission");
          const admittedRunContext = await admission.admit("gateway", params.runId);
          params.onExecutionPhase?.({ phase: "model_call_started" });
          await params.onExecutionStarted?.();
          await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
          if (params.trigger === "heartbeat") {
            const exec = createExecTool({
              config: params.config,
              agentId: params.agentId,
              sessionKey: params.sessionKey,
              runSessionKey: params.sessionKey,
              sessionId: params.sessionId,
              runId: params.runId,
              operationalRunInstance: admittedRunContext.operationalRunInstance,
              scopeKey: scope.sessionKey,
              host: "gateway",
              security: "full",
              ask: "off",
              allowBackground: true,
              notifyOnExit: true,
            });
            const identity = expectDefined(
              createAdmittedGatewayToolCallerIdentity({
                admittedRunContext,
                agentId: params.agentId,
                sessionKey: params.sessionKey,
              }),
              "admitted exec caller",
            );
            await withGatewayToolCallerIdentity(identity, async () => {
              const result = await exec.execute("periodic-background-check", {
                command: nodeCommand('process.stdout.write("PERIODIC_EXEC_COMPLETED")'),
                background: true,
              });
              expect(result.details.status).toBe("running");
              await waitForExecScope(scope.sessionKey);
            });
            return { payloads: [{ text: "Periodic work completed" }], meta: { durationMs: 1 } };
          }
          expect(params.trigger).toBe("event");
          expect(params.prompt).toContain("PERIODIC_EXEC_COMPLETED");
          return { payloads: [{ text: "Background result is ready" }], meta: { durationMs: 1 } };
        });
        let completion: ReturnType<typeof sessionEvents.enqueueSessionEventForHost> | undefined;
        try {
          const periodic = await runHeartbeatOnce({
            cfg: config,
            agentId: "main",
            source: "interval",
            intent: "scheduled",
            reason: "interval",
            deps: { telegram: sendHeartbeat },
          });
          expect(periodic).toMatchObject({ status: "ran" });
          completion = await withinTest(completionCreated.promise, signal);
          await expect(completion.accepted).resolves.toEqual({ ok: true });
          const outcome = await completion.settled;
          expect(outcome, JSON.stringify(outcome)).toMatchObject({
            status: "completed",
            executionStarted: true,
            delivered: visible,
          });
          expect(model).toHaveBeenCalledTimes(2);
          expect(sendHeartbeat).toHaveBeenCalledTimes(visible ? 1 : 0);
          expect(sendCompletion).toHaveBeenCalledTimes(visible ? 1 : 0);
          if (visible) {
            expect(sendCompletion).toHaveBeenCalledWith(
              expect.objectContaining({ channel: "telegram", to: destination }),
            );
          }
        } finally {
          await waitForExecScope(scope.sessionKey);
          await Promise.allSettled([completion?.settled]);
          observeCompletion.mockRestore();
          sendCompletion.mockRestore();
          runtimeRegistry.mockRestore();
          restoreActivePluginRegistrySnapshot(previousRegistry);
          resetProcessRegistryForTests();
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
