import { vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "./session-capability.test-support.ts";

export function sessionRpc(handlers: Record<string, (params?: unknown) => unknown>) {
  return vi.fn(async (method: string, params?: unknown) => {
    const handler = handlers[method];
    if (!Object.hasOwn(handlers, method) || !handler) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return handler(params);
  });
}

export function sessionRpcHarness(
  handlers: Parameters<typeof sessionRpc>[0],
  makeClient = (request: ReturnType<typeof sessionRpc>) =>
    ({ request }) as unknown as GatewayBrowserClient,
) {
  const request = sessionRpc(handlers);
  const client = makeClient(request);
  const harness = createGatewayHarness(client);
  return {
    ...harness,
    client,
    request,
    sessions: createTestSessionCapability(harness.gateway),
    changed: (payload: Record<string, unknown>) => harness.emitEvent(sessionChanged(payload)),
  };
}

export function sessionRow(id: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key: `agent:main:${id}`, sessionId: id, kind: "direct", ...fields };
}

export function patchReply(target: GatewaySessionRow, fields: Partial<GatewaySessionRow> = {}) {
  return { ok: true, key: target.key, entry: { ...target, ...fields } };
}

export function patchReceipt<const Entry>(
  key: string,
  entry: Entry,
  path = "(sessions)",
): { ok: true; path: string; key: string; entry: Entry } {
  return { ok: true, path, key, entry };
}

export function liveSessionEvent(
  row: GatewaySessionRow,
  fields: Partial<GatewaySessionRow>,
): GatewayEventFrame {
  return {
    type: "event",
    event: "session.message",
    payload: {
      archived: false,
      hasActiveRun: true,
      status: "running",
      ...row,
      ...fields,
      sessionKey: row.key,
    },
  };
}

export function sessionChanged(payload: Record<string, unknown>): GatewayEventFrame {
  return { type: "event", event: "sessions.changed", payload };
}
