import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { assert, expect, vi } from "vitest";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.js";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION, type ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { listNodePairing } from "../infra/device-pairing-node.js";
import { getPairedDevice, resolveNodePairingState } from "../infra/device-pairing.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { NodeRegistry } from "./node-registry.js";
import { createWatchNodeHttpRuntime } from "./watch-node-http.js";

const JSON_HEADERS = { "content-type": "application/json" };
export async function startWatchNodeHttpRuntime(
  baseDir: string,
  cleanups: Array<() => Promise<void>>,
  options?: {
    rateLimiter?: AuthRateLimiter;
    abortConnectResponse?: boolean;
    config?: OpenClawConfig;
    now?: () => number;
    onConnectResponseStart?: () => void;
    onPollReady?: (response: ServerResponse) => void;
  },
) {
  const nodeRegistry = new NodeRegistry({
    resolveCurrentPairingState: async (nodeId) => {
      const state = resolveNodePairingState(await getPairedDevice(nodeId, baseDir));
      return state
        ? { identity: state.identity.key, generation: state.generation?.key }
        : undefined;
    },
  });
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const connectedNodes: string[] = [];
  const disconnectedNodes: Array<{ nodeId: string; reason: string }> = [];
  const runtime = createWatchNodeHttpRuntime({
    nodeRegistry,
    getConfig: () => options?.config ?? {},
    pairingBaseDir: baseDir,
    broadcast: (event, payload) => broadcasts.push({ event, payload }),
    onNodeConnected: (session) => connectedNodes.push(session.nodeId),
    onNodeDisconnected: (nodeId, reason) => disconnectedNodes.push({ nodeId, reason }),
    rateLimiter: options?.rateLimiter,
    now: options?.now,
  });
  const connectHandled = createDeferred();
  const requests: Promise<void>[] = [];
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
      res.end = (() => res.destroy()) as typeof res.end;
    }
    const handling = runtime
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
      .finally(isConnect ? connectHandled.resolve : undefined);
    requests.push(handling);
    void handling.catch(() => {});
  });
  cleanups.push(async () => {
    runtime.close();
    await server[Symbol.asyncDispose]();
    const failure = (await Promise.allSettled(requests)).find(
      (result) => result.status === "rejected",
    );
    if (failure) {
      throw failure.reason;
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "expected TCP server address");
  return {
    nodeRegistry,
    broadcasts,
    connectedNodes,
    disconnectedNodes,
    runtime,
    connectHandled: connectHandled.promise,
    baseUrl: `http://127.0.0.1:${address.port}/api/nodes/watch`,
  };
}

export function makeConnectParams(
  params: Partial<
    Pick<ConnectParams, "caps" | "commands" | "permissions" | "minProtocol" | "maxProtocol">
  > & {
    identity: ReturnType<typeof loadOrCreateDeviceIdentity>;
    nonce: string;
    bootstrapToken?: string;
    deviceToken?: string;
    client?: Partial<ConnectParams["client"]>;
    signedAt?: number;
  },
): ConnectParams {
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
    auth: params.deviceToken
      ? { deviceToken: params.deviceToken }
      : { bootstrapToken: params.bootstrapToken },
    device: {
      id: params.identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(params.identity.publicKeyPem),
      signature: signDevicePayload(params.identity.privateKeyPem, signaturePayload),
      signedAt,
      nonce: params.nonce,
    },
  } as ConnectParams;
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

export function postWatchNode(url: string, body?: unknown, token?: unknown, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      ...(body === undefined ? {} : JSON_HEADERS),
      ...(token === undefined ? {} : { authorization: `Bearer ${String(token)}` }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function connectWatchNode({
  baseUrl,
  ...params
}: { baseUrl: string } & Omit<
  Parameters<typeof makeConnectParams>[0],
  "nonce" | "signedAt" | "caps" | "minProtocol" | "maxProtocol"
>): Promise<Response> {
  const { nonce, ts } = await readJson(await fetch(`${baseUrl}/challenge`));
  const connect = makeConnectParams({ ...params, nonce: String(nonce), signedAt: Number(ts) });
  return postWatchNode(`${baseUrl}/connect`, connect);
}

export function startPartialJsonRequest(params: { url: string; authorization: string }) {
  const response = createDeferred<{ statusCode: number; body: string }>();
  const request = httpRequest(
    params.url,
    {
      method: "POST",
      headers: { ...JSON_HEADERS, authorization: params.authorization },
    },
    (result) => {
      void text(result).then(
        (body) => response.resolve({ statusCode: result.statusCode ?? 0, body }),
        response.reject,
      );
    },
  );
  request.once("error", response.reject);
  return { request, response: response.promise };
}

export async function waitForLastConnectedMetadata(baseDir: string, nodeId: string): Promise<void> {
  await vi.waitFor(async () => {
    const paired = (await listNodePairing(baseDir)).paired.find((entry) => entry.nodeId === nodeId);
    expect(paired?.lastConnectedAtMs).toEqual(expect.any(Number));
  });
}
