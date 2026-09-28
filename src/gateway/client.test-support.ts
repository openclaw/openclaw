import { vi } from "vitest";

export function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

export function firstMockArg(mock: ReturnType<typeof vi.fn>, label: string): unknown {
  const [arg] = mock.mock.calls[0] ?? [];
  if (arg === undefined) {
    throw new Error(`expected ${label}`);
  }
  return arg;
}

export function createAuthFailureMessage(): string {
  const failureUrl = new URL("wss://gateway.example/ws?token=secret-token");
  failureUrl.username = "user";
  failureUrl.password = "pass";
  return `Authorization: Bearer sk-testsecret1234567890abcd ${failureUrl.href}`; // pragma: allowlist secret
}
