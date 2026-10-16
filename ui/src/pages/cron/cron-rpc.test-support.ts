import { vi } from "vitest";
import { createRequest } from "./cron-page.test-support.tsx";

export function cronRpc(
  handlers: Record<string, (params?: unknown) => unknown>,
  fallback: (method: string) => unknown = createRequest(),
) {
  return vi.fn(async (method: string, params?: unknown) =>
    Object.hasOwn(handlers, method) ? handlers[method]!(params) : fallback(method),
  );
}
