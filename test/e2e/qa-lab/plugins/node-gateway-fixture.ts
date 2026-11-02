import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import { startGatewayServer } from "../../../../src/gateway/server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import {
  acquireGatewayE2ePortBlock,
  startClaimedGateway,
} from "../../../../src/gateway/test-helpers.listener.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../../../src/plugins/runtime.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import { VERSION } from "../../../../src/version.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

type State = Awaited<ReturnType<typeof createOpenClawTestState>>;
type Registry = ReturnType<typeof createPluginRegistryFixture>["registry"];
type Context = { state: State; nodeId: string; gatewayToken: string; gatewayUrl: string };
type NodeInvokeFrame = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON: string | null;
  timeoutMs: number;
  idempotencyKey: string;
};
type Invocation = Omit<NodeInvokeFrame, "id" | "paramsJSON"> & { params: unknown };

/** Child receivers load their own plugins; the source retains the real registered dispatcher. */
export async function withNodeGateway(
  options: {
    label: string;
    plugin: Required<Pick<OpenClawPluginDefinition, "id" | "name" | "register">>;
    contracts?: Parameters<typeof registerVirtualTestPlugin>[0]["contracts"];
    env?: NodeJS.ProcessEnv;
    platform: string;
    caps: string[];
    commands: string[];
    config: (
      context: Pick<Context, "state" | "nodeId">,
    ) => OpenClawConfig | Promise<OpenClawConfig>;
  } & (
    | { receiver: "child"; onInvoke?: never }
    | { receiver?: "in-process"; onInvoke: (frame: NodeInvokeFrame) => string | Promise<string> }
  ),
  run: (
    context: Context & {
      config: OpenClawConfig;
      registry: Registry;
      operator: GatewayClient;
      node: GatewayClient;
      invocations: Invocation[];
    },
  ) => Promise<void>,
) {
  const state = await createOpenClawTestState({
    label: options.label,
    layout: "home",
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_FAST: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      ...options.env,
    },
  });
  const claim = options.receiver === "child" ? undefined : await acquireGatewayE2ePortBlock();
  let unstartedClaim: typeof claim | undefined = claim;
  const previousRegistry = captureActivePluginRegistrySnapshot();
  let gateway: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let stopReceiver: (() => Promise<void>) | undefined;
  let operator: GatewayClient | undefined;
  let node: GatewayClient | undefined;
  const invocations: Invocation[] = [];
  const responses: Promise<void>[] = [];
  const handlerErrors: unknown[] = [];
  try {
    const identity = (name: string) =>
      loadOrCreateDeviceIdentity({
        path: path.join(state.home, "proof-clients", name, "client", "credentials.sqlite"),
      });
    const nodeIdentity = identity("node");
    const source = {
      state,
      nodeId: nodeIdentity.deviceId,
    };
    const gatewayToken = `${options.label}-token`;
    const overrides = await options.config(source);
    const config: OpenClawConfig = {
      ...overrides,
      gateway: {
        mode: "local",
        ...(claim ? { port: claim.port } : {}),
        bind: "loopback",
        auth: { mode: "token", token: gatewayToken },
        controlUi: { enabled: false },
        ...overrides.gateway,
      },
    };
    await state.writeConfig(config);
    const { registry } = createPluginRegistryFixture(config);
    registerVirtualTestPlugin({
      registry,
      config,
      id: options.plugin.id,
      name: options.plugin.name,
      source: `extensions/${options.plugin.id}/index.ts`,
      contracts: options.contracts,
      register(api) {
        options.plugin.register?.(api);
      },
    });
    setActivePluginRegistry(registry.registry, options.label, "default", state.workspaceDir);
    let context: Context;
    if (options.receiver === "child") {
      // A plain registry has no Gateway nodes runtime. The receiver's normal loader
      // owns that runtime and catalog service in a separate state directory/process.
      setRuntimeConfigSnapshot(config);
      const { createQaGatewayChild } = await import("../../../../extensions/qa-lab/api.js");
      const owner = createQaGatewayChild();
      stopReceiver = () => stopQaGatewayFixture(owner);
      const receiver = await owner.start({
        repoRoot: process.cwd(),
        initializeCurrentRuntimeState: true,
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.resolve("openclaw.mjs")],
          cwd: process.cwd(),
          usePackagedPlugins: true,
        },
        transportBaseUrl: "http://127.0.0.1:1",
        enabledPluginIds: [options.plugin.id],
        controlUiEnabled: false,
        runtimeEnvPatch: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        },
        mutateConfig: (receiverConfig) => ({
          ...receiverConfig,
          gateway: { ...receiverConfig.gateway, nodes: config.gateway?.nodes },
          plugins: {
            allow: [options.plugin.id],
            slots: { memory: "none" },
            entries: { [options.plugin.id]: { enabled: true } },
          },
        }),
      });
      context = { ...source, gatewayToken: receiver.token, gatewayUrl: receiver.wsUrl };
    } else {
      if (!claim) {
        throw new Error("in-process Gateway requires a port claim");
      }
      unstartedClaim = undefined;
      gateway = await startClaimedGateway(claim, () =>
        startGatewayServer(claim.port, {
          bind: "loopback",
          auth: { mode: "token", token: gatewayToken },
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      );
      context = { ...source, gatewayToken, gatewayUrl: `ws://127.0.0.1:${claim.port}` };
    }
    const connection = {
      url: context.gatewayUrl,
      token: context.gatewayToken,
      clientVersion: options.receiver === "child" ? VERSION : "1.0.0",
      requestTimeoutMs: 60_000,
      timeoutMs: 60_000,
    };
    const respond = async (value: unknown) => {
      const frame = value as Partial<NodeInvokeFrame>;
      if (
        !node ||
        typeof frame.id !== "string" ||
        frame.nodeId !== context.nodeId ||
        typeof frame.command !== "string" ||
        typeof frame.timeoutMs !== "number" ||
        typeof frame.idempotencyKey !== "string" ||
        !(frame.paramsJSON === null || typeof frame.paramsJSON === "string")
      ) {
        throw new Error(`invalid node invocation: ${JSON.stringify(frame)}`);
      }
      const { id, nodeId, command, paramsJSON, timeoutMs, idempotencyKey } = frame;
      invocations.push({
        nodeId,
        command,
        timeoutMs,
        idempotencyKey,
        params: paramsJSON === null ? null : JSON.parse(paramsJSON),
      });
      const invocation = {
        id,
        nodeId,
        command,
        paramsJSON,
        timeoutMs,
        idempotencyKey,
      };
      if (options.receiver === "child") {
        // Production dispatch owns both success and failure replies; never acknowledge twice.
        const { handleInvoke } = await import("../../../../src/node-host/invoke.js");
        await handleInvoke(invocation, node, { current: async () => [] });
      } else {
        const payloadJSON = await options.onInvoke(invocation);
        await node.request("node.invoke.result", { id, nodeId, ok: true, payloadJSON });
      }
    };
    operator = await connectGatewayClient({
      ...connection,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: `${options.label}-operator`,
      platform: "linux",
      mode: GATEWAY_CLIENT_MODES.TEST,
      role: "operator",
      scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
      deviceIdentity: identity("operator"),
    });
    const manifest =
      options.receiver === "child"
        ? (
            await import("../../../../src/node-host/plugin-node-host.js")
          ).listRegisteredNodeHostCapsAndCommands(
            { config, env: state.env },
            { commandAllowlist: new Set(options.commands) },
          )
        : { caps: options.caps, commands: options.commands };
    expect(manifest.commands.toSorted()).toEqual(options.commands.toSorted());
    const connectNode = () =>
      connectGatewayClient({
        ...connection,
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientDisplayName: `${options.label}-node`,
        platform: options.platform,
        mode: GATEWAY_CLIENT_MODES.NODE,
        role: "node",
        scopes: [],
        caps: manifest.caps,
        commands: manifest.commands,
        deviceIdentity: nodeIdentity,
        onEvent: (event) => {
          if (event.event === "node.invoke.request") {
            responses.push(
              respond(event.payload).catch((error: unknown) => {
                handlerErrors.push(error);
              }),
            );
          }
        },
      });
    const activeOperator = operator;
    const approvePairing = async (kind: "device" | "node") => {
      const pending = await vi.waitFor(
        async () => {
          const result = await activeOperator.request<{
            pending: Array<{ requestId: string; deviceId?: string; nodeId?: string }>;
          }>(`${kind}.pair.list`, {});
          const request = result.pending.find(
            (entry) => (kind === "device" ? entry.deviceId : entry.nodeId) === context.nodeId,
          );
          expect(request).toBeDefined();
          return request!;
        },
        { timeout: 15_000 },
      );
      await activeOperator.request(`${kind}.pair.approve`, { requestId: pending.requestId });
    };
    try {
      node = await connectNode();
    } catch (error) {
      if (
        options.receiver !== "child" ||
        !isRecord(error) ||
        !isRecord(error.details) ||
        error.details.code !== "PAIRING_REQUIRED"
      ) {
        throw error;
      }
      await approvePairing("device");
      await approvePairing("node");
      node = await connectNode();
    }
    if (options.receiver === "child") {
      const { pending } = await activeOperator.request<{
        pending: Array<{ nodeId: string; requestId: string }>;
      }>("node.pair.list", {});
      const request = pending.find((entry) => entry.nodeId === context.nodeId);
      if (request) {
        await activeOperator.request("node.pair.approve", { requestId: request.requestId });
        await disconnectGatewayClient(node);
        node = await connectNode();
      }
    }
    await vi.waitFor(
      async () => {
        const result = await activeOperator.request<{
          nodes?: Array<{
            nodeId: string;
            connected?: boolean;
            commands?: string[];
            paired?: boolean;
            approvalState?: string;
          }>;
        }>("node.list", {});
        const connected = result.nodes?.find(
          (entry) => entry.nodeId === context.nodeId && entry.connected,
        );
        expect(connected).toBeDefined();
        expect(connected?.commands).toEqual([...options.commands].toSorted());
        if (options.receiver === "child") {
          expect(connected).toMatchObject({ paired: true, approvalState: "approved" });
        }
      },
      { timeout: 15_000, interval: 100 },
    );
    await run({ ...context, config, registry, operator, node, invocations });
  } finally {
    await runQaGatewayFixture(
      async () => {
        if (node) {
          await disconnectGatewayClient(node);
        }
      },
      async () => {
        await Promise.all(responses);
      },
      () => operator && disconnectGatewayClient(operator),
      () => gateway?.close({ reason: `${options.label} proof complete` }),
      () => stopReceiver?.(),
      () => unstartedClaim?.release(),
      () => restoreActivePluginRegistrySnapshot(previousRegistry),
      () => state.cleanup(),
    );
  }
  expect(handlerErrors).toEqual([]);
}
