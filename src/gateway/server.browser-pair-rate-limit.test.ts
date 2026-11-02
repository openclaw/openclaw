import { afterAll, beforeAll, expect, it } from "vitest";
import { signDevicePayload } from "../infra/device-identity.js";
import { buildBrowserPairPayload } from "../shared/browser-pair.js";
import { loadDeviceIdentity } from "./device-authz.test-helpers.js";
import { originForPort } from "./server.auth.test-helpers.js";
import { createGatewaySuiteHarness, installGatewayTestHooks, testState } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

beforeAll(async () => {
  testState.gatewayAuth = {
    mode: "token",
    token: "secret",
    rateLimit: { maxAttempts: 2, windowMs: 60_000, lockoutMs: 60_000 },
  };
  harness = await createGatewaySuiteHarness({ serverOptions: { controlUiEnabled: true } });
});

afterAll(async () => {
  await harness?.close();
});

function postStart(name: string) {
  const browser = loadDeviceIdentity(name);
  const { deviceId, privateKeyPem } = browser.identity;
  return fetch(`http://127.0.0.1:${harness.port}/__openclaw__/browser-pair/start`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: originForPort(harness.port) },
    body: JSON.stringify({
      deviceId,
      publicKey: browser.publicKey,
      signature: signDevicePayload(
        privateKeyPem,
        buildBrowserPairPayload({ action: "start", deviceId }),
      ),
    }),
  });
}

it("limits how many requests one source can file", async () => {
  expect((await postStart("rate-a")).status).toBe(200);
  expect((await postStart("rate-b")).status).toBe(200);
  const limited = await postStart("rate-c");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBeTruthy();
  expect(await limited.json()).toEqual({ error: "rate_limited" });
});
