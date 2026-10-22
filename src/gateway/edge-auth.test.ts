import { afterEach, describe, expect, it, vi } from "vitest";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";

const materializeSecretInput = vi.hoisted(() => vi.fn());

vi.mock("../secrets/resolve-secret-input-string.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets/resolve-secret-input-string.js")>();
  materializeSecretInput.mockImplementation(actual.materializeSecretInput);
  return { ...actual, materializeSecretInput };
});

import {
  gatewayEdgeAuthValueForTarget,
  normalizeEdgeAuthHeadersConfig,
  resolveEdgeAuthHeaders,
} from "./edge-auth.js";

const targetUrl = "wss://gateway.example/rpc";
const resolveHeaders = (
  value: Parameters<typeof resolveEdgeAuthHeaders>[0]["value"],
  options: Partial<Parameters<typeof resolveEdgeAuthHeaders>[0]> = {},
) => resolveEdgeAuthHeaders({ config: {}, value, targetUrl, env: {}, ...options });

describe("gateway edge auth headers", () => {
  afterEach(() => {
    materializeSecretInput.mockClear();
    resetSecretRedactionRegistryForTest();
  });

  it.each<[unknown, RegExp]>([
    [{ Host: "test-secret" }, /transport-owned header/u],
    [["X-Edge-Auth", "test-secret"], /expected a header map/u],
    [{ "Bad Header": "test-secret" }, /invalid gateway\.remote\.edgeAuth header name/u],
    [{}, /must not be empty/u],
    [{ "X-Edge-Auth": "one", "x-edge-auth": "two" }, /differ only by case/u],
  ])("rejects invalid header map %j", (value, error) => {
    expect(() => normalizeEdgeAuthHeadersConfig(value)).toThrow(error);
  });

  it("materializes SecretRefs and registers every resolved value for redaction", async () => {
    const first = "test-token";
    const second = "test-secret";
    const value = normalizeEdgeAuthHeadersConfig({
      "X-Edge-Token": { source: "env", provider: "default", id: "EDGE_AUTH_TOKEN" },
      "X-Edge-Secret": { source: "env", provider: "default", id: "EDGE_AUTH_SECRET" },
    });

    await expect(
      resolveHeaders(value, {
        env: { EDGE_AUTH_TOKEN: first, EDGE_AUTH_SECRET: second },
      }),
    ).resolves.toEqual({ "X-Edge-Token": first, "X-Edge-Secret": second });
    expect(isSecretValueRegisteredForRedaction(first)).toBe(true);
    expect(isSecretValueRegisteredForRedaction(second)).toBe(true);
  });

  it("names the header when a resolved value is empty", async () => {
    await expect(resolveHeaders({ "X-Empty-Edge-Auth": " " })).rejects.toThrow(
      'gateway.remote.edgeAuth header "X-Empty-Edge-Auth" resolved empty',
    );
  });

  it("binds configured headers to the exact configured remote Gateway scope", async () => {
    const edgeAuth = { "X-Edge-Auth": "test-secret" };
    const config = { gateway: { remote: { url: targetUrl, edgeAuth } } };
    const matchingConfig = normalizeEdgeAuthHeadersConfig(
      gatewayEdgeAuthValueForTarget({ config, targetUrl }),
    );
    expect(matchingConfig).toEqual(edgeAuth);
    await expect(resolveHeaders(matchingConfig, { config })).resolves.toEqual(edgeAuth);
    expect(
      gatewayEdgeAuthValueForTarget({ config, targetUrl: "wss://other.example/rpc" }),
    ).toBeUndefined();
  });

  it("rejects non-WSS targets before materializing edge-auth secrets", async () => {
    const value = normalizeEdgeAuthHeadersConfig({
      "X-Edge-Auth": { source: "env", provider: "default", id: "EDGE_AUTH_TOKEN" },
    });

    await expect(
      resolveHeaders(value, {
        targetUrl: "ws://gateway.example/rpc",
        env: { EDGE_AUTH_TOKEN: "test-token" },
      }),
    ).rejects.toThrow(/gateway\.remote\.edgeAuth.*wss:\/\//u);
    expect(materializeSecretInput).not.toHaveBeenCalled();
  });
});
