import { vi } from "vitest";

export function sessionRequest<T = unknown>(
  handlers: Record<string, ((params?: T) => unknown) | undefined>,
) {
  return vi.fn(async (method: string, params?: T): Promise<unknown> => {
    const handle = handlers[method];
    if (!Object.hasOwn(handlers, method) || !handle) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return handle(params);
  });
}
