import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import * as dispatchRuntime from "../../auto-reply/dispatch.js";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import * as routedReplies from "../../auto-reply/reply/route-reply.js";
import * as events from "../../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import type { GatewayRequestHandlerOptions } from "../../gateway/server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as exec from "../../infra/exec-request-context.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  applyEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
} from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { buildEmbeddedAttemptToolRunContext } from "../embedded-agent-runner/run/attempt-tool-run-context.js";
import type { RunEmbeddedAgentParams } from "../embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../embedded-agent.js";
import { createAgentHarnessHostCapabilities } from "../harness/host-capability.js";
import { resolveAttemptWorkspaceSandbox } from "../workspace-sandbox.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createPluginsTool } from "./plugins-tool.js";
// mock-isolation: Exercise real reload/handoff admission without starting a model-backed agent run.
vi.mock("../embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
await import("../../auto-reply/reply/get-reply-from-config.runtime.js").then((m) =>
  m.prewarmConfigDrivenReplyRuntime(),
);
async function attemptImplicitSend(params: RunEmbeddedAgentParams) {
  const admittedRunContext = expectDefined(
    await params.preparedRunAdmission?.admit("gateway", params.runId),
    "ordinary reply admission",
  );
  params.onExecutionPhase?.({ phase: "model_call_started" });
  await params.onExecutionStarted?.();
  await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
  const workspace = await resolveAttemptWorkspaceSandbox({ ...params, admittedRunContext });
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
      cwd: params.cwd,
      toolExecutionAllow: params.toolExecutionAllow,
      toolsAllow: params.toolsAllow,
      trigger: params.trigger,
      senderIsOwner: params.senderIsOwner,
    },
    pluginId: "openclaw",
  });
  try {
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
    const tools = applyEmbeddedAttemptToolsAllow(
      expectDefined(
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
          includeOpenClawTools: true,
          includePluginTools: false,
        },
      }),
      construction.runtimeToolAllowlist,
    );
    const message = expectDefined(
      tools.find((tool) => tool.name === "message"),
      "message tool",
    );
    try {
      return await message.execute("implicit-send", {
        action: "send",
        message: "Stay in this session.",
      });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  } finally {
    host.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
  resetSystemEventsForTest();
});
it.for([false, true])(
  "keeps a real reload continuation internal (queued: %s)",
  async (busy, { signal }) => {
    await withOpenClawTestState(
      { label: "reload-route-consumer", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const sessionKey = "agent:main:reload-route-consumer",
          sessionId = "reload-route-consumer",
          runId = "reload-source";
        const scope = { agentId: "main", sessionKey };
        const config = {
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: "mock-openai/gpt-5.6-luna" },
              models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
            },
          },
          plugins: { enabled: false },
          skills: { load: { watch: false } },
        };
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        await upsertSessionEntryCore(scope, {
          sessionId,
          permissionMode: "full",
          queueDebounceMs: 0,
          updatedAt: 1,
          delivery: normalizeSessionDeliveryState({ context: { channel: "telegram", to: "999" } }),
        });
        const operation = createTestReplyOperation({ sessionKey, sessionId });
        operation.setPhase("running");
        const active: { blocker?: ReturnType<typeof createTestReplyOperation> } = {};
        const cleanup = createDeferredCore();
        const enqueued = createDeferredCore<ReturnType<typeof events.enqueueSessionEventForHost>>();
        const dispatched = createDeferredCore<unknown>();
        const enqueue = events.enqueueSessionEventForHost;
        vi.spyOn(events, "enqueueSessionEventForHost").mockImplementation((text, options) => {
          if (busy) {
            active.blocker = createTestReplyOperation({ sessionKey, sessionId });
            active.blocker.setPhase("running");
          }
          const receipt = enqueue(text, options);
          enqueued.resolve(receipt);
          return receipt;
        });
        const dispatch = dispatchRuntime.dispatchInboundMessageWithRoutedChannelDispatcher;
        const observedContexts: unknown[] = [];
        vi.spyOn(
          dispatchRuntime,
          "dispatchInboundMessageWithRoutedChannelDispatcher",
        ).mockImplementation((input) => {
          observedContexts.push({
            channel: input.ctx.OriginatingChannel,
            chatType: input.ctx.ChatType,
          });
          const result = dispatch(input);
          void result.then(
            (r) => dispatched.resolve(r.deferredToActiveRun),
            (e: unknown) => dispatched.reject(e),
          );
          return result;
        });
        const routed = vi.spyOn(routedReplies, "routeReply");
        let implicitSend: unknown, messageProvider: unknown, messageTo: unknown;
        runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
          messageProvider = params.messageProvider;
          messageTo = params.messageTo;
          implicitSend = await attemptImplicitSend(params);
          return {
            payloads: [{ text: "Reload stayed in this session." }],
            meta: { durationMs: 1 },
          };
        });
        const context = createContext();
        context.getRuntimeConfig = () => config;
        context.resolveGatewayContext = () => context;
        context.getGatewayMethodRegistry = () =>
          createGatewayMethodRegistry([
            {
              name: "plugins.reload",
              scope: "operator.admin",
              owner: { kind: "core", area: "plugins" },
              handler: async ({ respond }: GatewayRequestHandlerOptions) => {
                respond(true, { ok: true });
              },
            },
          ]);
        let receipt: ReturnType<typeof events.enqueueSessionEventForHost> | undefined;
        try {
          await withPluginRuntimeGatewayRequestScope(
            { context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
            () =>
              withOperatorToolGatewayAuthority(
                { scopes: ["operator.admin"], operatorRoleActor: { kind: "system" } },
                () =>
                  exec.withExecRequestTurn({ identity: { ...scope, sessionId, runId } }, () =>
                    withGatewayToolCallerIdentity(
                      { ...scope, turnSourceChannel: "webchat", turnSourceTo: sessionKey },
                      async () => {
                        const result = await createPluginsTool({
                          sessionId,
                          runId,
                          onYield: () => operation.completeWithAfterClearBarrier(cleanup.promise),
                        }).execute("reload", { action: "reloadAndResume", pluginId: "fixture" });
                        expect(result.details).toMatchObject({ status: "started" });
                      },
                    ),
                  ),
              ),
          );
          cleanup.resolve();
          receipt = await withinTest(enqueued.promise, signal);
          if (busy) {
            await withinTest(receipt.accepted, signal);
            expect(await withinTest(dispatched.promise, signal)).toBe("followup");
            expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
            active.blocker?.complete();
          }
          expect(await withinTest(receipt.settled, signal)).toMatchObject({
            status: "completed",
            delivered: false,
          });
          expect(messageProvider).toBe("webchat");
          if (busy) {
            expect(messageTo).toBeUndefined();
          }
          expect(observedContexts).toEqual([{ channel: "webchat", chatType: undefined }]);
          expect(implicitSend).toContain("requires a target");
          expect(routed).not.toHaveBeenCalled();
        } finally {
          cleanup.resolve();
          active.blocker?.complete();
          operation.complete();
          await Promise.allSettled([receipt?.settled]);
        }
      },
    );
  },
);
