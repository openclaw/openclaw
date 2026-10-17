import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import type { WorkerTunnelHandle } from "../../gateway/worker-environments/tunnel.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";

vi.mock("../../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: vi.fn(() => {
    throw new Error("unexpected coding tool construction");
  }),
}));

const state = await setupAgentRunnerExecutionTestState();

let execute: Awaited<ReturnType<typeof getExecuteAgentTurnForTest>>;
let fixture: typeof import("../../gateway/worker-environments/worker-turn-launcher.test-support.js");
beforeEach(async () => {
  execute = await getExecuteAgentTurnForTest();
  fixture = await import("../../gateway/worker-environments/worker-turn-launcher.test-support.js");
  await fixture.setupWorkerTurnLauncherTest();
});
afterEach(async () => {
  (await import("../../plugins/runtime.js")).resetPluginRuntimeStateForTest();
  (await import("../../infra/agent-run-registry.js")).resetAgentRunRegistryForTest();
  await fixture.cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true });
});
afterAll(async () => {
  const { closeOpenClawStateDatabaseAsync, closeOpenClawStateDatabaseForTest } =
    await import("../../state/openclaw-state-db.js");
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

const cases = [
  ...(
    [
      "full",
      "shared",
      "workspace",
      "raw",
      "unrelated-command",
      "missing-descriptor",
      "expanded-descriptor",
    ] as const
  ).map((mode) => ({
    mode,
    phase: "startup" as const,
  })),
  ...(
    [
      "permission",
      "session",
      "admission",
      "gateway",
      "node",
      "plugin",
      "placement",
      "runtime-plugin",
      "runtime-retired",
      "runtime-reactivated",
      "gateway-reactivated",
      "gateway-republished",
      "runtime-record-revoked",
    ] as const
  ).flatMap((mode) => (["startup", "policy"] as const).map((phase) => ({ mode, phase }))),
];
it.each(cases)(
  "webchat node duplex authority carries only current admitted Full: $mode ($phase)",
  async ({ mode, phase }) => {
    const { createAgentHarnessHostCapabilities } =
      await import("../../agents/harness/host-capability.js");
    const { upsertSessionEntryCore } = await import("../../config/sessions/session-accessor.js");
    const { createGatewayMethodRegistry } = await import("../../gateway/methods/registry.js");
    const { applyPluginNodeInvokePolicy } =
      await import("../../gateway/node-invoke-plugin-policy.js");
    const { createContext, createNodeSession } =
      await import("../../gateway/node-invoke-plugin-policy.test-helpers.js");
    const { runWithGatewayRequestEnvelope } = await import("../../gateway/server-methods.js");
    const { createGatewayNodesRuntime } = await import("../../gateway/server-plugins.js");
    const { success } = await import("../../gateway/worker-environments/tunnel.test-support.js");
    const { createPluginRecord } = await import("../../plugins/loader-records.js");
    const { markPluginRegistryActive, markPluginRegistryRetired, revokePluginRecord } =
      await import("../../plugins/registry-lifecycle.js");
    const { createEmptyPluginRegistry } = await import("../../plugins/registry-empty.js");
    const { withPluginRuntimePluginScope, withPluginRuntimeRegistryScope } =
      await import("../../plugins/runtime/gateway-request-scope.js");
    const { getActivePluginRegistry, getActivePluginRegistryVersion, setActivePluginRegistry } =
      await import("../../plugins/runtime.js");
    const {
      attachedEnvironment,
      createWorkerSessionTurnPlacementProvider,
      ENVIRONMENT_ID,
      OWNER_EPOCH,
      placements,
      root,
      reconcileUnchangedLocalWorkspace,
      seedActivePlacement,
      SESSION_ID,
      SESSION_KEY,
      sessionTarget,
      unusedEnvironments,
      workerTurnRequest,
    } = fixture;
    await upsertSessionEntryCore(sessionTarget, { permissionMode: "full" });
    await seedActivePlacement("remote-exec");
    const workspace = {
      workspaceDir: "/worker/workspace",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
    };
    const command =
      mode === "unrelated-command" || mode === "expanded-descriptor" ? "demo.other" : "demo.read";
    const requiredNodeCommands = mode === "missing-descriptor" ? undefined : ["demo.read"];
    const node = createNodeSession();
    node.declaredCommands = ["demo.read", "demo.other"];
    node.commands = [...node.declaredCommands];
    const { context, invoke } = createContext({
      nodeSession: node,
      getRuntimeConfig: () => ({ gateway: { nodes: { commands: { allow: node.commands } } } }),
    });
    let currentContext: GatewayRequestContext | undefined = context;
    context.resolveGatewayContext = () => currentContext;
    const registry = createEmptyPluginRegistry();
    const nodes = createGatewayNodesRuntime(context.resolveGatewayContext);
    const record = createPluginRecord({
      id: "demo",
      source: "fixture",
      origin: "bundled",
      enabled: true,
      configSchema: true,
    });
    registry.plugins.push(record);
    for (const declaredCommand of node.commands) {
      registry.nodeHostCommands.push({
        pluginId: record.id,
        source: "fixture",
        command: {
          command: declaredCommand,
          dangerous: true,
          duplex: true,
          handle: async () => "{}",
        },
      });
    }
    const prompt = vi.fn();
    let revoke = async () => {};
    registry.nodeInvokePolicies.push({
      pluginId: record.id,
      source: "fixture",
      policy: {
        commands: [...node.commands],
        async handle(policy) {
          await Promise.resolve();
          if (phase === "policy") {
            await revoke();
          }
          const result = await policy.invokeNodeWithSessionFull?.({
            workspace,
            createParams: () => ({ placement: workspace, authorization: "session-full" }),
          });
          if (result) {
            return result;
          }
          prompt();
          return { ok: false, code: "APPROVAL_REQUIRED", message: "one-time approval required" };
        },
      },
    });
    const preparedRegistry = createEmptyPluginRegistry();
    const preparedRecord = { ...record };
    preparedRegistry.plugins.push(preparedRecord);
    preparedRegistry.nodeHostCommands.push(...registry.nodeHostCommands);
    const scopedRegistry = mode === "shared" ? registry : preparedRegistry;
    setActivePluginRegistry(registry);
    const activeRegistryVersion = getActivePluginRegistryVersion();
    const methodRegistry = createGatewayMethodRegistry(
      [
        {
          name: "node.invoke",
          owner: { kind: "core", area: "nodes" },
          scope: "operator.write",
          async handler(options) {
            const result = await applyPluginNodeInvokePolicy({
              context: options.context,
              client: options.client,
              nodeSession: node,
              command,
              params: options.params.params,
              sessionKey: options.params.sessionKey as string,
              nodeInvokeStream: options.client?.internal?.nodeInvokeStream,
            });
            if (result?.ok) {
              options.respond(true, result.payload);
            } else {
              options.respond(false, undefined, {
                code: "INVALID_REQUEST",
                message: result?.message ?? "missing policy",
              });
            }
          },
        },
      ],
      registry,
    );
    context.getGatewayMethodRegistry = () => methodRegistry;
    invoke.mockImplementation(async (params) => {
      expect(params?.isDispatchAuthorized?.()).toBe(true);
      params?.onDispatchReady?.("fixture-invoke");
      params?.onProgress?.(JSON.stringify({ v: 1, kind: "ready" }));
      return { ok: true, payload: { launched: true } };
    });
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runWorkspaceCommand: vi.fn(async () => success()),
      syncWorkspace: vi.fn(),
      quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
      reconcileWorkspace: reconcileUnchangedLocalWorkspace,
      stop: async () => {},
    };
    const environment = {
      ...attachedEnvironment(),
      providerId: "device",
      nodeDeviceId: node.nodeId,
      sshEndpoint: null,
    };
    const claimTurn = vi.spyOn(placements, "claimTurn");
    const placement = createWorkerSessionTurnPlacementProvider({
      placements,
      environments: {
        ...unusedEnvironments(),
        get: () => environment,
        startTunnel: async () => tunnel,
      },
    });
    const launchErrors: string[] = [];
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (originalParams: RunEmbeddedAgentParams) => {
        // The shared fixture omits runId from its parameter stub; retain the real admission's id.
        const admission = originalParams.preparedRunAdmission!;
        const params = { ...originalParams, runId: admission.operationalRunInstance.runId };
        return placement.executeTurn(
          workerTurnRequest(params.runId),
          { ...params, sessionFile: SESSION_KEY, sessionTarget },
          async () => {
            const admittedRunContext = await admission.admit("plugin-harness");
            const host = createAgentHarnessHostCapabilities({
              attempt: {
                ...params,
                admittedRunContext,
                sessionTarget,
              },
              pluginId: record.id,
              requiredNodeCommands,
            });
            if (mode === "expanded-descriptor") {
              requiredNodeCommands?.push("demo.other");
            }
            const reactivate = (target: typeof registry) => {
              markPluginRegistryRetired(target);
              markPluginRegistryActive(target);
            };
            const revocations: Partial<Record<typeof mode, () => unknown>> = {
              permission: () =>
                upsertSessionEntryCore(sessionTarget, { permissionMode: "workspace" }),
              session: () =>
                upsertSessionEntryCore(sessionTarget, { sessionId: "replacement-session" }),
              admission: () => admission.close(),
              gateway: () => {
                currentContext = { ...context };
              },
              node: () => {
                environment.nodeDeviceId = "replacement-node";
              },
              plugin: () => registry.plugins.splice(0, 1, { ...record }),
              "runtime-plugin": () => preparedRegistry.plugins.splice(0, 1, { ...preparedRecord }),
              "runtime-retired": () => markPluginRegistryRetired(preparedRegistry),
              "runtime-reactivated": () => reactivate(preparedRegistry),
              "gateway-reactivated": () => reactivate(registry),
              "gateway-republished": () => markPluginRegistryActive(registry),
              "runtime-record-revoked": () => revokePluginRecord(preparedRegistry, preparedRecord),
              placement: async () => {
                const claimed = claimTurn.mock.results[0];
                if (claimed?.type !== "return") {
                  throw new Error("expected an admitted placement claim");
                }
                await placements.cancelWorkspaceResultAndReleaseTurn(await claimed.value, {
                  reason: "node-disconnect",
                });
              },
            };
            revoke = async () => {
              await revocations[mode]?.();
            };
            try {
              await withPluginRuntimeRegistryScope(scopedRegistry, () =>
                host.runWithScope(() =>
                  withPluginRuntimePluginScope(
                    { pluginId: record.id, pluginOrigin: "bundled" },
                    async () => {
                      // Runtime initialization completes asynchronously before opening the channel.
                      await new Promise<void>((resolve) => {
                        setImmediate(resolve);
                      });
                      if (phase === "startup") {
                        await revoke();
                      }
                      try {
                        const input = {
                          nodeId: node.nodeId,
                          command,
                          params: workspace,
                          sessionKey: SESSION_KEY,
                        };
                        if (mode === "raw") {
                          await nodes.invoke(input);
                        } else {
                          const channel = await nodes.openDuplex(input);
                          await channel.closed;
                        }
                      } catch (error) {
                        launchErrors.push((error as Error).message);
                      }
                    },
                  ),
                ),
              );
            } finally {
              host.close();
            }
            return { payloads: [{ text: "finished" }], meta: { durationMs: 1 } };
          },
        );
      },
    );
    const followupRun = createFollowupRun();
    Object.assign(followupRun.run, {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentDir: root,
      workspaceDir: root,
      permissionMode: mode === "workspace" ? "workspace" : "full",
    });

    const reply = await runWithGatewayRequestEnvelope(
      "sessions.send",
      null,
      () =>
        execute({
          ...createMinimalRunAgentTurnParams({ followupRun }),
          sessionKey: SESSION_KEY,
        }),
      {
        context,
        isWebchatConnect: () => true,
        methodRegistry,
        reject: (error) => {
          throw new Error(error.message);
        },
      },
    );
    // Error classification may load provider hooks, but must not replace the node-policy registry.
    expect(getActivePluginRegistry()).toBe(registry);
    expect(getActivePluginRegistryVersion()).toBe(activeRegistryVersion);
    if (mode !== "placement" && mode !== "session") {
      expect(reply).toMatchObject({ kind: "success" });
    }
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const accepted = ["full", "shared", "gateway-republished"].includes(mode);
    const approvalRequired = [
      "workspace",
      "raw",
      "unrelated-command",
      "missing-descriptor",
      "expanded-descriptor",
    ].includes(mode);
    expect(prompt.mock.calls).toHaveLength(approvalRequired ? 1 : 0);
    expect(invoke.mock.calls).toHaveLength(accepted ? 1 : 0);
    expect(launchErrors).toEqual(
      accepted
        ? []
        : [
            approvalRequired
              ? "one-time approval required"
              : expect.stringMatching(/no longer (active|current)/),
          ],
    );
    if (accepted) {
      expect(invoke.mock.calls[0]?.[0]).toMatchObject({
        params: { placement: workspace, authorization: "session-full" },
      });
    }
    currentContext = undefined;
  },
);
