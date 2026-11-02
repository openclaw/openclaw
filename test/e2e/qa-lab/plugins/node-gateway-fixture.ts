import { X509Certificate } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";
import path from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../../src/config/runtime-snapshot.js";
import type { GatewayAuthConfig } from "../../../../src/config/types.gateway.js";
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
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
} from "../../../../src/test-helpers/proxy-tls-fixture.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import { VERSION } from "../../../../src/version.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const RECEIVER_ORIGIN = "https://session-share.example.test";
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
    onPhase?: (phase: string) => void;
    receiverUsers?: NonNullable<GatewayAuthConfig["identityScopes"]>;
    prepareReceiverState?: (env: NodeJS.ProcessEnv) => Promise<void>;
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
      connectReader: (email: string) => Promise<GatewayClient>;
      node: GatewayClient;
      invocations: Invocation[];
    },
  ) => Promise<void>,
) {
  options.onPhase?.("state:start");
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
  options.onPhase?.("state:ready");
  const claim = options.receiver === "child" ? undefined : await acquireGatewayE2ePortBlock();
  let unstartedClaim: typeof claim | undefined = claim;
  const previousRegistry = captureActivePluginRegistrySnapshot();
  let gateway: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let stopReceiver: (() => Promise<void>) | undefined;
  let stopReaderTransport: (() => Promise<void>) | undefined;
  let operator: GatewayClient | undefined;
  let node: GatewayClient | undefined;
  const readers: GatewayClient[] = [];
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
      options.onPhase?.("receiver:start");
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
          // This fixture selects trusted-proxy auth; the QA owner's token default is incompatible.
          ...(options.receiverUsers ? { OPENCLAW_GATEWAY_TOKEN: undefined } : {}),
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        },
        mutateConfig: (receiverConfig) => ({
          ...receiverConfig,
          gateway: {
            ...receiverConfig.gateway,
            nodes: config.gateway?.nodes,
            ...(options.receiverUsers
              ? {
                  trustedProxies: ["127.0.0.1", "::1"],
                  auth: {
                    mode: "trusted-proxy" as const,
                    password: receiverConfig.gateway?.auth?.token,
                    identityScopes: options.receiverUsers,
                    trustedProxy: {
                      userHeader: "x-forwarded-user",
                      requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
                      allowLoopback: true,
                      allowUsers: Object.keys(options.receiverUsers),
                      deviceAutoApprove: {
                        enabled: true,
                        scopes: [...new Set(Object.values(options.receiverUsers).flat())],
                      },
                    },
                  },
                  controlUi: { enabled: false, allowedOrigins: [RECEIVER_ORIGIN] },
                }
              : {}),
          },
          plugins: {
            allow: [options.plugin.id],
            slots: { memory: "none" },
            entries: { [options.plugin.id]: { enabled: true } },
          },
        }),
      });
      if (options.prepareReceiverState) {
        options.onPhase?.("receiver:state");
        // Seed through the child's stopped-state owner so the running profile
        // catalog cannot retain a snapshot from before fixture identity creation.
        await receiver.restartAfterStateMutation(({ runtimeEnv }) =>
          options.prepareReceiverState!(runtimeEnv),
        );
      }
      options.onPhase?.("receiver:ready");
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
      ...(options.receiverUsers
        ? { password: context.gatewayToken }
        : { token: context.gatewayToken }),
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
    let readerUrl = context.gatewayUrl;
    if (options.receiverUsers) {
      // Exercise the client's real edge-auth TLS contract. The QA child owns
      // its loopback listener; this fixture owns only the TLS ingress and sockets.
      const upstreamUrl = new URL(context.gatewayUrl);
      const sockets = new Set<Socket>();
      const ingress = createTlsServer(
        { key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE },
        (socket) => {
          const upstream = connectTcp(Number(upstreamUrl.port), upstreamUrl.hostname);
          sockets.add(upstream);
          upstream.once("close", () => {
            sockets.delete(upstream);
            socket.destroy();
          });
          socket.once("close", () => upstream.destroy());
          socket.once("error", () => upstream.destroy());
          upstream.once("error", () => socket.destroy());
          socket.pipe(upstream).pipe(socket);
        },
      );
      ingress.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      stopReaderTransport = () =>
        new Promise<void>((resolve, reject) => {
          ingress.close((error) => (error ? reject(error) : resolve()));
          for (const socket of sockets) {
            socket.destroy();
          }
        });
      await new Promise<void>((resolve, reject) => {
        ingress.once("error", reject);
        ingress.listen(0, "127.0.0.1", () => {
          ingress.removeListener("error", reject);
          resolve();
        });
      });
      const address = ingress.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing receiver TLS ingress address");
      }
      readerUrl = `wss://127.0.0.1:${address.port}`;
    }
    const connectReader = async (email: string) => {
      const scopes = options.receiverUsers?.[email];
      if (!scopes) {
        throw new Error("Unknown receiver fixture user");
      }
      const url = new URL(context.gatewayUrl);
      const origin = RECEIVER_ORIGIN;
      const reader = await connectGatewayClient({
        ...connection,
        url: readerUrl,
        tlsFingerprint: new X509Certificate(PROXY_FIXTURE_CERTIFICATE).fingerprint256,
        token: undefined,
        password: undefined,
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        platform: "web",
        role: "operator",
        scopes,
        origin,
        edgeAuthHeaders: {
          "x-forwarded-user": email,
          "x-forwarded-for": "198.51.100.40",
          "x-forwarded-proto": "https",
          "x-forwarded-host": url.host,
          "x-openclaw-scopes": scopes.join(","),
        },
        deviceIdentity: identity(email),
      });
      readers.push(reader);
      return reader;
    };
    options.onPhase?.("operator:connect");
    operator = options.receiverUsers
      ? await connectReader(Object.keys(options.receiverUsers)[0]!)
      : await connectGatewayClient({
          ...connection,
          clientName: GATEWAY_CLIENT_NAMES.TEST,
          clientDisplayName: `${options.label}-operator`,
          platform: "linux",
          mode: GATEWAY_CLIENT_MODES.TEST,
          role: "operator",
          scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
          deviceIdentity: identity("operator"),
        });
    options.onPhase?.("operator:ready");
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
    options.onPhase?.("callback:enter");
    await run({ ...context, config, registry, operator, node, invocations, connectReader });
    options.onPhase?.("callback:complete");
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
      () => Promise.all(readers.map(disconnectGatewayClient)),
      () => operator && !readers.includes(operator) && disconnectGatewayClient(operator),
      () => gateway?.close({ reason: `${options.label} proof complete` }),
      () => stopReaderTransport?.(),
      () => stopReceiver?.(),
      () => unstartedClaim?.release(),
      () => restoreActivePluginRegistrySnapshot(previousRegistry),
      () => state.cleanup(),
    );
  }
  expect(handlerErrors).toEqual([]);
}
