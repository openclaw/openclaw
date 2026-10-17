import path from "node:path";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, vi } from "vitest";
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

type State = Awaited<ReturnType<typeof createOpenClawTestState>>;
type Registry = ReturnType<typeof createPluginRegistryFixture>["registry"];
type Context = { state: State; nodeId: string; gatewayToken: string; gatewayUrl: string };

/** Paired-node transport shared by the Canvas and exact-file-approval proofs. */
export async function withNodeGateway(
  options: {
    label: string;
    plugin: Required<Pick<OpenClawPluginDefinition, "id" | "name" | "register">>;
    contracts?: Parameters<typeof registerVirtualTestPlugin>[0]["contracts"];
    env?: NodeJS.ProcessEnv;
    platform: string;
    caps: string[];
    commands: string[];
    config: (context: Context) => OpenClawConfig | Promise<OpenClawConfig>;
    onInvoke: (client: GatewayClient | undefined, frame: unknown, nodeId: string) => void;
    beforeCleanup?: () => Promise<unknown>;
  },
  run: (
    context: Context & { config: OpenClawConfig; registry: Registry; operator: GatewayClient },
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
  const claim = await acquireGatewayE2ePortBlock();
  let unstartedClaim: typeof claim | undefined = claim;
  const previousRegistry = captureActivePluginRegistrySnapshot();
  let gateway: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let operator: GatewayClient | undefined;
  let node: GatewayClient | undefined;
  try {
    const identity = (name: string) =>
      loadOrCreateDeviceIdentity({ path: path.join(state.home, `${name}.sqlite`) });
    const nodeIdentity = identity("node");
    const context = {
      state,
      nodeId: nodeIdentity.deviceId,
      gatewayToken: `${options.label}-token`,
      gatewayUrl: `ws://127.0.0.1:${claim.port}`,
    };
    const overrides = await options.config(context);
    const config: OpenClawConfig = {
      ...overrides,
      gateway: {
        mode: "local",
        port: claim.port,
        bind: "loopback",
        auth: { mode: "token", token: context.gatewayToken },
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
    unstartedClaim = undefined;
    gateway = await startClaimedGateway(claim, () =>
      startGatewayServer(claim.port, {
        bind: "loopback",
        auth: { mode: "token", token: context.gatewayToken },
        controlUiEnabled: false,
        sidecarStartup: "defer",
      }),
    );
    const connection = {
      url: context.gatewayUrl,
      token: context.gatewayToken,
      clientVersion: "1.0.0",
      requestTimeoutMs: 60_000,
      timeoutMs: 60_000,
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
    node = await connectGatewayClient({
      ...connection,
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: `${options.label}-node`,
      platform: options.platform,
      mode: GATEWAY_CLIENT_MODES.NODE,
      role: "node",
      scopes: [],
      caps: options.caps,
      commands: options.commands,
      deviceIdentity: nodeIdentity,
      onEvent: (event) => {
        if (event.event === "node.invoke.request") {
          options.onInvoke(node, event.payload, context.nodeId);
        }
      },
    });
    const activeOperator = operator;
    await vi.waitFor(
      async () => {
        const result = await activeOperator.request<{
          nodes?: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
        }>("node.list", {});
        const connected = result.nodes?.find(
          (entry) => entry.nodeId === context.nodeId && entry.connected,
        );
        expect(connected).toBeDefined();
        expect(connected?.commands).toEqual([...options.commands].toSorted());
      },
      { timeout: 15_000, interval: 100 },
    );
    await run({ ...context, config, registry, operator });
  } finally {
    await options.beforeCleanup?.();
    if (node) {
      await disconnectGatewayClient(node);
    }
    if (operator) {
      await disconnectGatewayClient(operator);
    }
    if (gateway) {
      await gateway.close({ reason: `${options.label} proof complete` });
    }
    await unstartedClaim?.release();
    restoreActivePluginRegistrySnapshot(previousRegistry);
    await state.cleanup();
  }
}
