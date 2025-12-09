import { randomUUID } from "node:crypto";
import { GatewayClient } from "./client.js";

export type CallGatewayOptions = {
  url?: string;
  token?: string;
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

export async function callGateway<T = unknown>(opts: CallGatewayOptions): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const stop = (err?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value as T);
    };

    const client = new GatewayClient({
      url: opts.url,
      token: opts.token,
      instanceId: opts.instanceId ?? randomUUID(),
      clientName: opts.clientName ?? "cli",
      clientVersion: opts.clientVersion ?? "dev",
      platform: opts.platform,
      mode: opts.mode ?? "cli",
      minProtocol: opts.minProtocol ?? 1,
      maxProtocol: opts.maxProtocol ?? 1,
      onHelloOk: async () => {
        try {
          const result = await client.request<T>(opts.method, opts.params, {
            expectFinal: opts.expectFinal,
          });
          client.stop();
          stop(undefined, result);
        } catch (err) {
          client.stop();
          stop(err as Error);
        }
      },
      onClose: (code, reason) => {
        stop(new Error(`gateway closed (${code}): ${reason}`));
      },
    });

    const timer = setTimeout(() => {
      client.stop();
      stop(new Error("gateway timeout"));
    }, timeoutMs);

    client.start();
  });
}

export function randomIdempotencyKey() {
  return randomUUID();
}
