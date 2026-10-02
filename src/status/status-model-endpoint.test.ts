import { afterEach, describe, expect, it } from "vitest";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { sealSecretSentinel } from "../secrets/sentinel.js";
import { formatModelEndpointUrl } from "./status-model-endpoint.js";

describe("model endpoint display", () => {
  afterEach(() => {
    resetSecretRedactionRegistryForTest();
  });

  it("does not disclose a registered credential after URL hostname normalization", () => {
    registerSecretValueForRedaction("MixedCaseCredential");
    expect(
      formatModelEndpointUrl("https://route.MixedCaseCredential.example.test/v1/responses"),
    ).toBeUndefined();
    expect(formatModelEndpointUrl("https://safe.example.test/v1/responses")).toBe(
      "https://safe.example.test/v1/responses",
    );
  });

  it("does not disclose a sentinel in a selected endpoint hostname", () => {
    const sentinel = sealSecretSentinel("short", { label: "endpoint-hostname" });
    expect(formatModelEndpointUrl(`https://${sentinel}.example.test/v1`)).toBeUndefined();
  });

  it.each([
    ["https://api.openai.com/v1/responses", "https://api.openai.com/v1/responses"],
    [
      "wss://chatgpt.com/backend-api/codex/responses",
      "wss://chatgpt.com/backend-api/codex/responses",
    ],
    [
      "https://user:password@example.test:9443/v1/responses?key=secret#secret",
      "https://example.test:9443/v1/responses",
    ],
    ["http://127.0.0.1:1234/private-token/v1/responses", "http://127.0.0.1:1234/[path hidden]"],
    ["https://example.test/tenant/secret", "https://example.test/[path hidden]"],
    ["https://example.test/v1/", "https://example.test/v1"],
    ["https://example.test", "https://example.test"],
    ["https://example.test/[path hidden]", "https://example.test/[path hidden]"],
    ["file:///tmp/credentials", undefined],
    ["not a URL", undefined],
    ["https://example.test/" + "x".repeat(8192), undefined],
  ] as const)("projects %s without credential-bearing URL components", (url, expected) => {
    expect(formatModelEndpointUrl(url)).toBe(expected);
  });
});
