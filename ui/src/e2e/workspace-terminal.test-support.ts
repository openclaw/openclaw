import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";

type Root = Page | Locator;
export async function expectAbsent(root: Root, selectors: string[]) {
  for (const selector of selectors) {
    expect(await root.locator(selector).count(), selector).toBe(0);
  }
}

export async function expectNoRequests(gateway: MockGatewayControls, methods: string[]) {
  for (const method of methods) {
    expect(await gateway.getRequests(method), method).toHaveLength(0);
  }
}

export function expectRequestCount(
  gateway: MockGatewayControls,
  method: string,
  count: number,
  timeout?: number,
) {
  return expect
    .poll(
      async () => (await gateway.getRequests(method)).length,
      timeout === undefined ? undefined : { timeout },
    )
    .toBe(count);
}

export function terminalSession(
  sessionId: string,
  overrides: Partial<{
    agentId: string;
    confined: boolean;
    cwd: string;
    shell: string;
    title: string;
    owner: string;
  }> = {},
) {
  return {
    agentId: "main",
    confined: false,
    cwd: "/workspace",
    sessionId,
    shell: "/bin/bash",
    ...overrides,
  };
}

export function nativeAuth(page: Page, token = "test", gatewayUrl = "ws://gateway.example.test") {
  return page.addInitScript(
    (auth) => {
      (
        window as Window & {
          __OPENCLAW_NATIVE_CONTROL_AUTH__?: { gatewayUrl: string; token: string };
        }
      )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = auth;
    },
    { gatewayUrl, token },
  );
}
