import { randomUUID } from "node:crypto";
import { loadConfig, resolveGatewayPort } from "../config/config.js";
import { GatewayClient } from "./client.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";

export type CallGatewayOptions = {
  url?: string;
  token?: string;
  password?: string;
  method: string;
  params?: unknown;
  expectFinal?: boolean;
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
  platform?: string;
  mode?: string;
  instanceId?: string;
  minProtocol?: number;
  maxProtocol?: number;
};

export async function callGateway<T = unknown>(
  opts: CallGatewayOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const config = loadConfig();
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = isRemoteMode ? config.gateway?.remote : undefined;
  const authToken = config.gateway?.auth?.token;
  const localPort = resolveGatewayPort(config);
  const url =
    (typeof opts.url === "string" && opts.url.trim().length > 0
      ? opts.url.trim()
      : undefined) ||
    (typeof remote?.url === "string" && remote.url.trim().length > 0
      ? remote.url.trim()
      : undefined) ||
    `ws://127.0.0.1:${localPort}`;
  const token =
    (typeof opts.token === "string" && opts.token.trim().length > 0
      ? opts.token.trim()
      : undefined) ||
    (isRemoteMode
      ? typeof remote?.token === "string" && remote.token.trim().length > 0
        ? remote.token.trim()
        : undefined
      : process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() ||
        (typeof authToken === "string" && authToken.trim().length > 0
          ? authToken.trim()
          : undefined));
  const password =
    (typeof opts.password === "string" && opts.password.trim().length > 0
      ? opts.password.trim()
      : undefined) ||
    process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim() ||
    (typeof remote?.password === "string" && remote.password.trim().length > 0
      ? remote.password.trim()
      : undefined);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let ignoreClose = false;
    const stop = (err?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value as T);
    };

    const client = new GatewayClient({
      url,
      token,
      password,
      instanceId: opts.instanceId ?? randomUUID(),
      clientName: opts.clientName ?? "cli",
      clientVersion: opts.clientVersion ?? "dev",
      platform: opts.platform,
      mode: opts.mode ?? "cli",
      minProtocol: opts.minProtocol ?? PROTOCOL_VERSION,
      maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION,
      onHelloOk: async () => {
        try {
          const result = await client.request<T>(opts.method, opts.params, {
            expectFinal: opts.expectFinal,
          });
          ignoreClose = true;
          stop(undefined, result);
          client.stop();
        } catch (err) {
          ignoreClose = true;
          client.stop();
          stop(err as Error);
        }
      },      onClose: (code, reason) => {
        if (settled || ignoreClose) return;
        ignoreClose = true;
        client.stop();
        stop(new Error(`gateway closed (${code}): ${reason}`));
      },
    });

    const timer = setTimeout(() => {
      ignoreClose = true;
      client.stop();
      stop(new Error("gateway timeout"));
    }, timeoutMs);

    client.start();
  });
}

export function randomIdempotencyKey() {
  return randomUUID();
}
