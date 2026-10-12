import { extractToolResultText } from "@openclaw/ai/internal/shared";
// Provider replay preserves source text and structured tool-result values.
import { describe, expect, it } from "vitest";
// Importing the facade installs the OpenClaw AI transport host ports.
import "./stream.js";

describe("tool result fidelity via AI transport host", () => {
  it("preserves structured fields and source strings", () => {
    const text = extractToolResultText([
      {
        type: "json",
        apiToken: "api-token-value-1234567890",
        privateKey: "private-key-value-1234567890",
        private_key: "private-key-snake-1234567890",
        key: "generic-key-value-1234567890",
        keyMaterial: "key-material-value-1234567890",
        bearerToken: "bearer-token-value-1234567890",
        bearer_token: "bearer-token-snake-value-1234567890",
        jwt: "jwt-value-1234567890",
        session: "session-value-1234567890",
        code: "code-value-1234567890",
        error: { code: "ERR_VISIBLE_PROVIDER_CODE" },
        oauth: { code: "OPAQUEPROVIDERCODE1234567890" },
        providerError: { error: { code: "ERR_VISIBLE_PROVIDER_NESTED_CODE" } },
        signature: "signature-value-1234567890",
        cookie: "cookie-value-1234567890",
        "set-cookie": "set-cookie-value-1234567890",
        paymentCredential: "payment-credential-value-1234567890",
        cardNumber: 4111111111111111,
        cvc: 123,
        text: '{"apiToken":"api-token-in-text-1234567890","code":"oauth-code-in-text-1234567890","safe":"ok"}',
        credential: "live-credential-value",
        appSecret: "app-secret-value",
        rawSecret: "raw-secret-value",
        nested: {
          token: "nested-token-value",
          visible: "safe-value",
        },
      },
    ]);

    expect(text).toContain('"credential":"');
    expect(text).toContain('"appSecret":"');
    expect(text).toContain('"rawSecret":"');
    expect(text).toContain('"token":"');
    expect(text).toContain('"visible":"safe-value"');
    expect(text).toContain('"code":"ERR_VISIBLE_PROVIDER_CODE"');
    expect(text).toContain('"code":"ERR_VISIBLE_PROVIDER_NESTED_CODE"');
    expect(text).toContain("api-token-value-1234567890");
    expect(text).toContain("private-key-value-1234567890");
    expect(text).toContain("private-key-snake-1234567890");
    expect(text).toContain("generic-key-value-1234567890");
    expect(text).toContain("key-material-value-1234567890");
    expect(text).toContain("bearer-token-value-1234567890");
    expect(text).toContain("bearer-token-snake-value-1234567890");
    expect(text).toContain("jwt-value-1234567890");
    expect(text).toContain("session-value-1234567890");
    expect(text).toContain("code-value-1234567890");
    expect(text).toContain("OPAQUEPROVIDERCODE1234567890");
    expect(text).toContain("signature-value-1234567890");
    expect(text).toContain("cookie-value-1234567890");
    expect(text).toContain("set-cookie-value-1234567890");
    expect(text).toContain("payment-credential-value-1234567890");
    expect(text).toContain("4111111111111111");
    expect(text).toContain('"cvc":123');
    expect(text).toContain("api-token-in-text-1234567890");
    expect(text).toContain("oauth-code-in-text-1234567890");
    expect(text).toContain('\\"safe\\":\\"ok\\"');
    expect(text).toContain("live-credential-value");
    expect(text).toContain("app-secret-value");
    expect(text).toContain("raw-secret-value");
    expect(text).toContain("nested-token-value");
  });
});
