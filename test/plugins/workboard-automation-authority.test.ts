import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../extensions/workboard/api.js";
import plugin from "../../extensions/workboard/index.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../src/agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../src/agents/tools/gateway-caller-context.js";
import { CronService } from "../../src/cron/service.js";
import {
  createCronStoreHarness,
  createFinishedBarrier,
  createNoopLogger,
} from "../../src/cron/service.test-harness.js";
import type { CronServiceDeps } from "../../src/cron/service/state.js";
import type { GatewayMethodDescriptorInput } from "../../src/gateway/methods/descriptor.js";
import { createGatewayMethodRegistry } from "../../src/gateway/methods/registry.js";
import type { GatewayRequestHandler } from "../../src/gateway/server-methods/types.js";
import { createContext } from "../../src/gateway/server-plugin-in-process-dispatch.test-support.js";
import { dispatchTrustedPluginGatewayMethod } from "../../src/gateway/server-plugins.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../src/infra/diagnostic-events.js";
import type { PluginHookHandlerMap } from "../../src/plugins/hook-types.js";
import { bindPluginRegistryRuntime } from "../../src/plugins/registry-runtime-binding.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../src/plugins/runtime/gateway-request-scope.js";
import { startPluginServices } from "../../src/plugins/services.js";
import { createTestGatewayScheduler } from "../../src/test-utils/gateway-scheduler-clock.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "workboard-nudge-" });

it.each(["agent_end", "subagent_ended"] as const)(
  "Workboard terminal hook %s survives closure",
  async (hook) => {
    const sessionKey = "agent:main:subagent:workboard-d6-authority";
    const runId = `d6-${hook}`;
    const { storePath } = await makeStorePath();
    vi.stubEnv("OPENCLAW_STATE_DIR", path.dirname(storePath));
    const gatewayContext = createContext();
    const gatewayScope = {
      pluginId: "workboard",
      pluginOrigin: "bundled" as const,
      context: gatewayContext,
      isWebchatConnect: () => false,
    };
    const inGatewayScope = <T>(run: () => T) =>
      withPluginRuntimeGatewayRequestScope(gatewayScope, run);
    const finished = createFinishedBarrier();
    const executeJob = vi.fn<NonNullable<CronServiceDeps["runSessionEvent"]>>(async () => {
      expect(getGatewayToolCallerIdentity()).toBeUndefined();
      expect(getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext?.()).toBe(gatewayContext);
      return { status: "ok" };
    });
    const scheduler = createTestGatewayScheduler();
    const cron = new CronService({
      scheduler,
      nowMs: () => Date.now(),
      storePath,
      cronEnabled: false,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runSessionEvent: executeJob,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      onEvent: finished.onEvent,
    });
    const job = await cron.add({
      name: "Workboard automation",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "categorize board" },
    });
    const settled = finished.waitForOk(job.id);
    const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
    let agentEnd: PluginHookHandlerMap["agent_end"] | undefined;
    let subagentEnded: PluginHookHandlerMap["subagent_ended"] | undefined;
    const methods: GatewayMethodDescriptorInput[] = [];
    const captured = capturePluginRegistration({
      ...plugin,
      register(api) {
        api.registerService = (service) => services.push(service);
        api.registerGatewayMethod = (name, handler, options) => {
          methods.push({
            name,
            handler,
            scope: options?.scope ?? "operator.admin",
            owner: { kind: "plugin", pluginId: "workboard" },
          });
        };
        api.on = (name, handler) => {
          if (name === "agent_end") {
            agentEnd = handler as typeof agentEnd;
          } else if (name === "subagent_ended") {
            subagentEnded = handler as typeof subagentEnded;
          }
        };
        plugin.register({
          ...api,
          runtimeSource: fileURLToPath(
            new URL("../../extensions/workboard/index.ts", import.meta.url),
          ),
          runtime: {
            ...api.runtime,
            gateway: {
              ...api.runtime.gateway,
              isAvailable: async () => true,
              request: dispatchTrustedPluginGatewayMethod,
            },
          },
        });
      },
    });
    const warn = vi.fn();
    const registry = createEmptyPluginRegistry();
    bindGatewayContextResolver(captured.api.runtime, () => gatewayContext);
    bindPluginRegistryRuntime(registry, captured.api.runtime);
    for (const service of services.filter((entry) =>
      ["workboard-automation-nudge", "workboard-lifecycle-sync"].includes(entry.id),
    )) {
      registry.services.push({
        pluginId: "workboard",
        origin: "bundled",
        source: "test",
        id: service.id,
        service: {
          ...service,
          apiVersion: 2,
          start: (ctx) =>
            inGatewayScope(() => service.start({ ...ctx, logger: { ...ctx.logger, warn } })),
        },
      });
    }
    const handle = await startPluginServices({
      scheduler,
      registry,
      config: {},
      getCronService: () => cron,
    });
    const enqueue = vi.spyOn(cron, "enqueueRun");
    const dispatch: GatewayRequestHandler = async ({ respond }) =>
      respond(true, await cron.enqueueRun(job.id, "if-enabled"));
    const describeSession: GatewayRequestHandler = ({ respond }) => {
      expect(getGatewayToolCallerIdentity()).toBeUndefined();
      respond(true, {
        session: { key: sessionKey, status: "done", updatedAt: Date.now(), hasActiveRun: false },
      });
    };
    gatewayContext.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry([
        ...methods,
        {
          name: "sessions.describe",
          scope: "operator.read",
          owner: { kind: "core", area: "sessions" },
          handler: describeSession,
        },
        {
          name: "cron.run",
          scope: "operator.admin",
          owner: { kind: "core", area: "cron" },
          handler: dispatch,
        },
      ]);
    const request = <T>(method: string, params: Record<string, unknown>) =>
      inGatewayScope(() =>
        dispatchTrustedPluginGatewayMethod<T>(method, params, { scopes: ["operator.admin"] }),
      );
    const expectRunRejected = () =>
      expect(request("cron.run", { id: job.id, mode: "if-enabled" })).rejects.toThrow(
        "agent tool caller authority is no longer active",
      );
    const admission = prepareAgentRunAdmission({
      cfg: {},
      facts: {
        runId,
        agentId: "main",
        ingress: { kind: "system", boundary: "d6-proof", state: "present" },
      },
      operationalRunInstance: createOperationalRunInstanceRef(runId),
    });
    const diagnosticsEnabled = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    try {
      await request("workboard.boards.upsert", { id: "planning", automationJobId: job.id });
      const { card } = await request<{ card: WorkboardCard }>("workboard.cards.create", {
        title: "Completed worker",
        status: "running",
        boardId: "planning",
        sessionKey,
        runId,
      });
      const admittedRunContext = await admission.admit("plugin-harness", "codex");
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext,
        agentId: "main",
        sessionKey,
      });
      if (!caller) {
        throw new Error("Expected an admitted worker caller");
      }
      await inGatewayScope(() =>
        withGatewayToolCallerIdentity(caller, async () => {
          const pending =
            hook === "agent_end"
              ? agentEnd!({ messages: [], success: true }, { agentId: "main", sessionKey, runId })
              : subagentEnded!(
                  {
                    targetSessionKey: sessionKey,
                    targetKind: "subagent",
                    runId,
                    endedAt: card.updatedAt + 1,
                    outcome: "ok",
                    reason: "subagent-complete",
                  },
                  { childSessionKey: sessionKey, runId },
                );
          admission.close();
          await pending;
          await expectRunRejected();
        }),
      );

      await withGatewayToolCallerIdentity({ ...caller }, async () => {
        await expectRunRejected();
      });
      await expect(request("workboard.cards.list", { boardId: "planning" })).resolves.toMatchObject(
        {
          cards: [expect.objectContaining({ id: card.id, status: "review" })],
        },
      );
      expect(enqueue).toHaveBeenCalledOnce();
      await settled;
      expect(executeJob).toHaveBeenCalledOnce();
      // The sibling terminal event for the same card shares the service's debounce owner.
      await agentEnd!({ messages: [], success: true }, { agentId: "main", sessionKey, runId });
      expect(enqueue).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      setDiagnosticsEnabledForProcess(diagnosticsEnabled);
      admission.close();
      await handle.stop();
      cron.stop();
      await scheduler.stop();
      for (const lifecycle of captured.runtimeLifecycles) {
        await lifecycle.dispose?.();
      }
      vi.unstubAllEnvs();
    }
  },
);
