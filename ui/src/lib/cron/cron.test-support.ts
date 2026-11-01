import { vi } from "vitest";
import { createInitialCronState } from "./state.ts";
import type { CronState } from "./types.ts";

export function createStateWithRequest(
  request: unknown,
  overrides: Partial<CronState> = {},
): CronState {
  return {
    ...createInitialCronState({ connected: true, client: { request } as CronState["client"] }),
    ...overrides,
  };
}

export function createMethodRequest(
  responses: Readonly<Record<string, unknown>>,
  handlers: Readonly<Record<string, (payload?: unknown) => unknown>> = {},
) {
  return vi.fn(async (method: string, payload?: unknown) => {
    const handler = handlers[method];
    return handler ? handler(payload) : (responses[method] ?? {});
  });
}
