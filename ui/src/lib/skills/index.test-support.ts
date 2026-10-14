import { vi } from "vitest";

export type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

export function createDeferredRequestQueue(request: ReturnType<typeof vi.fn<TestRequest>>) {
  const resolvers: Array<(value: unknown) => void> = [];
  request.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  );
  return {
    resolveNext(value: unknown) {
      resolvers.shift()?.(value);
    },
  };
}
