import { expect } from "vitest";
import type { MockGatewayControls, MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";

export function configResponse(prefs: Record<string, unknown>, hash: string) {
  const config = { ui: { prefs } };
  return {
    appliedConfigHash: hash,
    config,
    configRevisionHash: hash,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe("object");
  expect(Array.isArray(value), label).toBe(false);
  // SAFETY: The assertions above establish a present, non-array protocol record.
  return value as Record<string, unknown>;
}

export function patchPrefs(request: MockGatewayRequest): Record<string, unknown> {
  const params = requireRecord(request.params, "config.patch params");
  expect(typeof params.raw).toBe("string");
  const parsed = requireRecord(JSON.parse(String(params.raw)), "config.patch raw");
  const ui = requireRecord(parsed.ui, "config.patch ui");
  return requireRecord(ui.prefs, "config.patch ui.prefs");
}

export async function waitForRequestCount(
  gateway: MockGatewayControls,
  method: string,
  count: number,
): Promise<void> {
  await expect
    .poll(async () => (await gateway.getRequests(method)).length, { timeout: 10_000 })
    .toBe(count);
}

export async function resetSyncedPreference(options: {
  click: () => Promise<void>;
  expectedKey: string;
  expectedPrefs?: Record<string, unknown>;
  gateway: MockGatewayControls;
  hash: string;
  remainingPrefs: Record<string, unknown>;
}): Promise<void> {
  const patchCount = (await options.gateway.getRequests("config.patch")).length;
  const configGetCount = (await options.gateway.getRequests("config.get")).length;
  await options.gateway.setMethodResponse(
    "config.get",
    configResponse(options.remainingPrefs, options.hash),
  );

  await options.click();
  await waitForRequestCount(options.gateway, "config.patch", patchCount + 1);
  const patches = await options.gateway.getRequests("config.patch");
  expect(patchPrefs(patches[patchCount]!)).toEqual(
    options.expectedPrefs ?? {
      [options.expectedKey]: null,
    },
  );
  await waitForRequestCount(options.gateway, "config.get", configGetCount + 1);
}
