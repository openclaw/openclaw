import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type ServerResponse,
} from "node:http";
import { afterEach, expect, vi } from "vitest";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.js";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION, type ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import {
  listenLoopback,
  readRequestText,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { issueDevicePairSetupBootstrapToken } from "../infra/device-bootstrap.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { withDevicePairingLock } from "../infra/device-pairing-lock.js";
import { listNodePairing } from "../infra/device-pairing-node.js";
import { getPairedDevice, resolveNodePairingState } from "../infra/device-pairing.js";
import {
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  type DeviceBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { NodeRegistry } from "./node-registry.js";
import { createWatchNodeHttpRuntime } from "./watch-node-http.js";

const tempDirs = createTrackedTempDirs();
export const cleanups: Array<() => Promise<void>> = [];
const databasePaths = new Set<string>();

export function registerWatchNodeFixtureCleanup(): void {
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Watch node fixture cleanup failed", { cause: errors[0] });
    }
    // Handlers enqueue connection history; drain that writer before closing its database.
    await withDevicePairingLock(async () => {});
    for (const databasePath of databasePaths) {
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
    }
    await tempDirs.cleanup();
    cleanups.length = 0;
    databasePaths.clear();
    vi.unstubAllEnvs();
  });
}

export async function makeWatchNodeDir(prefix: string): Promise<string> {
  const baseDir = await tempDirs.make(prefix);
  databasePaths.add(
    resolveOpenClawStateSqlitePath({ ...process.env, OPENCLAW_STATE_DIR: baseDir }),
  );
  return baseDir;
}

export async function createWatchNodeFixture(
  prefix: string,
  options?: Parameters<typeof startWatchNodeHttpRuntime>[2] & {
    bootstrapProfile?: DeviceBootstrapProfile;
  },
) {
  const baseDir = await makeWatchNodeDir(prefix);
  const identity = loadOrCreateDeviceIdentity({
    env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
  });
  const issued = await issueDevicePairSetupBootstrapToken({
    baseDir,
    profile: options?.bootstrapProfile ?? NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  });
  return {
    baseDir,
    identity,
    issued,
    ...(await startWatchNodeHttpRuntime(baseDir, cleanups, options)),
  };
}

export async function startWatchNodeHttpRuntime(
  baseDir: string,
  runtimeCleanups: Array<() => Promise<void>>,
  options?: {
    rateLimiter?: AuthRateLimiter;
    abortConnectResponse?: boolean;
    config?: OpenClawConfig;
    now?: () => number;
    onConnectResponseStart?: () => void;
    onPollReady?: (response: ServerResponse) => void;
  },
) {
  vi.stubEnv("OPENCLAW_STATE_DIR", baseDir);
  const nodeRegistry = new NodeRegistry({
    resolveCurrentPairingState: async (nodeId) => {
      const state = resolveNodePairingState(await getPairedDevice(nodeId, baseDir));
      return state
        ? {
            identity: state.identity.key,
            ...(state.generation ? { generation: state.generation.key } : {}),
          }
        : undefined;
    },
  });
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const connectedNodes: string[] = [];
  const disconnectedNodes: Array<{ nodeId: string; reason: string }> = [];
  const runtime = createWatchNodeHttpRuntime({
    nodeRegistry,
    getConfig: () => options?.config ?? {},
    broadcast: (event, payload) => broadcasts.push({ event, payload }),
    onNodeConnected: (session) => connectedNodes.push(session.nodeId),
    onNodeDisconnected: (nodeId, reason) => disconnectedNodes.push({ nodeId, reason }),
    ...(options?.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
    ...(options?.now ? { now: options.now } : {}),
  });
  const connectHandled = createDeferred();
  const requests: Array<Promise<PromiseSettledResult<void>[]>> = [];
  const server = createServer((req, res) => {
    const isConnect = req.url === "/api/nodes/watch/connect";
    if (isConnect && options?.onConnectResponseStart) {
      const end = res.end.bind(res);
      res.end = ((...args: Parameters<typeof res.end>) => {
        options.onConnectResponseStart?.();
        return end(...args);
      }) as typeof res.end;
    }
    if (isConnect && options?.abortConnectResponse) {
      res.end = (() => {
        res.destroy();
        return res;
      }) as typeof res.end;
    }
    requests.push(
      Promise.allSettled([
        runtime
          .handleRequest(req, res)
          .then((handled) => {
            if (!handled && !res.writableEnded) {
              res.statusCode = 404;
              res.end();
            }
            if (req.url === "/api/nodes/watch/poll" && !res.writableEnded) {
              options?.onPollReady?.(res);
            }
          })
          .finally(() => {
            if (isConnect) {
              connectHandled.resolve();
            }
          }),
      ]),
    );
  });
  const settleRequests = async () => {
    const results = (await Promise.all(requests)).flat();
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  };
  runtimeCleanups.push(async () => {
    await runtime.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await settleRequests();
  });
  const origin = await listenLoopback(server);
  return {
    nodeRegistry,
    broadcasts,
    connectedNodes,
    disconnectedNodes,
    runtime,
    connectHandled: connectHandled.promise,
    settleRequests,
    baseUrl: `${origin}/api/nodes/watch`,
  };
}

export function makeConnectParams(params: {
  identity: ReturnType<typeof loadOrCreateDeviceIdentity>;
  nonce: string;
  bootstrapToken?: string;
  deviceToken?: string;
  client?: Partial<ConnectParams["client"]>;
  caps?: string[];
  commands?: string[];
  permissions?: ConnectParams["permissions"];
  minProtocol?: number;
  maxProtocol?: number;
  signedAt?: number;
}): ConnectParams {
  const publicKey = publicKeyRawBase64UrlFromPem(params.identity.publicKeyPem);
  const auth = params.deviceToken
    ? { deviceToken: params.deviceToken }
    : { bootstrapToken: params.bootstrapToken };
  const signedAt = params.signedAt ?? Date.now();
  const client: ConnectParams["client"] = {
    id: GATEWAY_CLIENT_IDS.WATCHOS_APP,
    displayName: "Test Watch",
    version: "1.0.0",
    platform: "watchOS 11.5.0",
    deviceFamily: "Apple Watch",
    mode: GATEWAY_CLIENT_MODES.NODE,
    instanceId: "watch-test",
    ...params.client,
  };
  const scopes: string[] = [];
  const signaturePayload = buildDeviceAuthPayloadV3({
    deviceId: params.identity.deviceId,
    clientId: client.id,
    clientMode: client.mode,
    role: "node",
    scopes,
    signedAtMs: signedAt,
    token: params.deviceToken ?? params.bootstrapToken ?? null,
    nonce: params.nonce,
    platform: client.platform,
    deviceFamily: client.deviceFamily,
  });
  return {
    minProtocol: params.minProtocol ?? PROTOCOL_VERSION,
    maxProtocol: params.maxProtocol ?? PROTOCOL_VERSION,
    client,
    caps: params.caps ?? [],
    commands: params.commands ?? ["device.info", "device.status", "system.notify"],
    permissions: params.permissions ?? { notifications: true },
    role: "node",
    scopes,
    auth,
    device: {
      id: params.identity.deviceId,
      publicKey,
      signature: signDevicePayload(params.identity.privateKeyPem, signaturePayload),
      signedAt,
      nonce: params.nonce,
    },
  } as ConnectParams;
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

export async function connectWatchNode(
  params: Pick<
    Parameters<typeof makeConnectParams>[0],
    "identity" | "client" | "bootstrapToken" | "deviceToken" | "commands" | "permissions"
  > & { baseUrl: string },
): Promise<Response> {
  const challenge = await readJson(await fetch(`${params.baseUrl}/challenge`));
  return await fetch(`${params.baseUrl}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      makeConnectParams({
        identity: params.identity,
        client: params.client,
        nonce: String(challenge.nonce),
        signedAt: Number(challenge.ts),
        bootstrapToken: params.bootstrapToken,
        deviceToken: params.deviceToken,
        commands: params.commands,
        permissions: params.permissions,
      }),
    ),
  });
}

export function startPartialJsonRequest(params: { url: string; authorization: string }): {
  request: ClientRequest;
  response: Promise<{ statusCode: number; body: string }>;
} {
  let request!: ClientRequest;
  const response = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    request = httpRequest(
      params.url,
      {
        method: "POST",
        headers: {
          authorization: params.authorization,
          "content-type": "application/json",
        },
      },
      (result) => {
        void readRequestText(result).then(
          (body) => resolve({ statusCode: result.statusCode ?? 0, body }),
          reject,
        );
      },
    );
    request.once("error", reject);
  });
  return { request, response };
}

export async function waitForLastConnectedMetadata(baseDir: string, nodeId: string): Promise<void> {
  await vi.waitFor(async () => {
    const paired = (await listNodePairing(baseDir)).paired.find((entry) => entry.nodeId === nodeId);
    expect(paired?.lastConnectedAtMs).toEqual(expect.any(Number));
  });
}
