import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
} from "./cron-page.test-support.tsx";

export function mountCronPage(
  source: GatewayBrowserClient | ((method: string, params?: unknown) => unknown),
  options: {
    render?: boolean;
    scopeId?: string | null;
    selectedId?: string | null;
  } = {},
) {
  const client =
    typeof source === "function"
      ? ({ request: source } as unknown as GatewayBrowserClient)
      : source;
  const gateway = createGateway(client, true);
  const context = createContext(gateway, options.scopeId, options.selectedId);
  const page = createPage(context, { render: options.render ?? true });
  return { client, gateway, context, page };
}

export function cronRpc(
  handlers: Record<string, (params?: unknown) => unknown>,
  fallback: (method: string) => unknown = createRequest(),
) {
  return vi.fn(async (method: string, params?: unknown) =>
    Object.hasOwn(handlers, method) ? handlers[method]!(params) : fallback(method),
  );
}

export function emitEvent(
  gateway: Pick<ReturnType<typeof createGateway>, "emitRetiredEvent">,
  event = "cron",
  payload: unknown = {},
  count = 1,
) {
  for (let index = 0; index < count; index += 1) {
    gateway.emitRetiredEvent({ type: "event", event, payload });
  }
}
