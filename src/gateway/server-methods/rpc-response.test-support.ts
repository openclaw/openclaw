import { expect } from "vitest";

export function expectRpcResult(respond: unknown, result: unknown) {
  expect(respond).toHaveBeenCalledWith(true, result, undefined);
}

export function expectRpcError(respond: unknown, error: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}
