import { describe, expect, it } from "vitest";
import { describeToolResultMediaPlaceholder, extractToolResultText } from "./tool-result-text.js";

describe("extractToolResultText", () => {
  it("redacts structured secret fields with the shared tool-payload contract", () => {
    const text = extractToolResultText([
      {
        type: "json",
        apiToken: "api-token-value-1234567890",
        privateKey: "private-key-value-1234567890",
        private_key: "private-key-snake-1234567890",
        key: "generic-key-value-1234567890",
        keyMaterial: "key-material-value-1234567890",
        jwt: "jwt-value-1234567890",
        session: "session-value-1234567890",
        code: "VISIBLE_STATUS_CODE",
        error: { code: "ERR_VISIBLE_PROVIDER_CODE" },
        oauth: { code: "OPAQUEPROVIDERCODE1234567890" },
        providerError: { error: { code: "ERR_VISIBLE_PROVIDER_NESTED_CODE" } },
        signature: "signature-value-1234567890",
        cookie: "cookie-value-1234567890",
        "set-cookie": "set-cookie-value-1234567890",
        paymentCredential: "payment-credential-value-1234567890",
        cardNumber: 4111111111111111,
        cvc: 123,
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
    expect(text).toContain('"code":"VISIBLE_STATUS_CODE"');
    expect(text).toContain('"code":"ERR_VISIBLE_PROVIDER_CODE"');
    expect(text).toContain('"code":"ERR_VISIBLE_PROVIDER_NESTED_CODE"');
    expect(text).not.toContain("api-token-value-1234567890");
    expect(text).not.toContain("private-key-value-1234567890");
    expect(text).not.toContain("private-key-snake-1234567890");
    expect(text).not.toContain("generic-key-value-1234567890");
    expect(text).not.toContain("key-material-value-1234567890");
    expect(text).not.toContain("jwt-value-1234567890");
    expect(text).not.toContain("session-value-1234567890");
    expect(text).not.toContain("OPAQUEPROVIDERCODE1234567890");
    expect(text).not.toContain("signature-value-1234567890");
    expect(text).not.toContain("cookie-value-1234567890");
    expect(text).not.toContain("set-cookie-value-1234567890");
    expect(text).not.toContain("payment-credential-value-1234567890");
    expect(text).not.toContain("4111111111111111");
    expect(text).not.toContain('"cvc":123');
    expect(text).not.toContain("live-credential-value");
    expect(text).not.toContain("app-secret-value");
    expect(text).not.toContain("raw-secret-value");
    expect(text).not.toContain("nested-token-value");
  });

  it("keeps media-only blocks out of provider replay text", () => {
    const text = extractToolResultText([
      { type: "text", text: "summary" },
      { type: "image", data: "image-binary", mimeType: "image/png" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
      { type: "input_image", image_url: "data:image/png;base64,def456" },
      { type: "audio", data: "audio-binary", mimeType: "audio/mpeg" },
    ]);

    expect(text).toBe("summary");
    expect(text).not.toContain("image-binary");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("def456");
    expect(text).not.toContain("audio-binary");
  });

  it("omits MIME-tagged binary data while preserving textual resource data", () => {
    const text = extractToolResultText([
      { type: "resource", mime_type: "application/octet-stream", data: "AAECAwQFBgc=" },
      { type: "resource", mediaType: "application/json", data: '{"ok":true}' },
    ]);

    expect(text).toContain('"data":"[binary data omitted: 12 chars]"');
    expect(text).toContain('{\\"ok\\":true}');
    expect(text).not.toContain("AAECAwQFBgc=");
  });

  it("redacts inline data URIs without touching ordinary data-colon prose", () => {
    const text = extractToolResultText([
      {
        type: "json",
        value: {
          note: "metadata:ready",
          prose: "data: is ordinary prose",
          preview: "thumbnail=data:image/png;base64,abcdef done",
        },
      },
    ]);

    expect(text).toContain("metadata:ready");
    expect(text).toContain("data: is ordinary prose");
    expect(text).toContain("[inline data URI:");
    expect(text).not.toContain("abcdef");
  });

  it("omits opaque or binary structured fields", () => {
    const text = extractToolResultText([
      {
        type: "json",
        encrypted_content: "ciphertext",
        bytes: [1, 2, 3],
        visible: "safe-value",
      },
    ]);

    expect(text).toContain('"encrypted_content":"[omitted encrypted_content]"');
    expect(text).toContain('"bytes":"[omitted bytes]"');
    expect(text).toContain('"visible":"safe-value"');
    expect(text).not.toContain("ciphertext");
  });

  it("uses structured replay only as a no-text fallback without capping explicit text", () => {
    const textTail = "explicit-tail-marker";
    const text = extractToolResultText([
      { type: "text", text: `${"x".repeat(8_200)}${textTail}` },
      { type: "json", internal: "extra structured detail" },
    ]);

    expect(text).toContain(textTail);
    expect(text).not.toContain("…(truncated)…");
    expect(text).not.toContain("extra structured detail");
  });

  it("truncates structured fallback text before provider replay", () => {
    const tail = "tail-marker";
    const text = extractToolResultText([
      {
        type: "json",
        data: {
          payload: `${"x".repeat(8_200)}${tail}`,
        },
      },
    ]);

    expect(text.length).toBeLessThan(8_100);
    expect(text).toContain("…(truncated)…");
    expect(text).not.toContain(tail);
  });
});

describe("describeToolResultMediaPlaceholder", () => {
  it("describes image-only tool result media", () => {
    expect(
      describeToolResultMediaPlaceholder([{ type: "image", mimeType: "image/png", data: "img" }]),
    ).toBe("(see attached image)");
  });

  it("describes audio-only tool result media", () => {
    expect(
      describeToolResultMediaPlaceholder([
        { type: "audio", mimeType: "audio/mpeg", data: "audio" },
      ]),
    ).toBe("(see attached audio)");
  });

  it("describes mixed image and audio tool result media", () => {
    expect(
      describeToolResultMediaPlaceholder([
        { type: "image", mimeType: "image/png", data: "img" },
        { type: "audio", mimeType: "audio/mpeg", data: "audio" },
      ]),
    ).toBe("(see attached media)");
  });
});
