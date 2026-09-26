import { describe, expect, it } from "vitest";
import {
  redactModelVisibleSecrets,
  redactModelVisibleSensitiveFieldValueWithConfig,
  redactModelVisibleToolPayloadText,
  redactModelVisibleToolPayloadTextWithConfig,
  redactToolPayloadTextWithConfig,
} from "./redact.js";
import { withFullContextToolPayloadRedaction } from "./redact.test-support.js";

describe("model-visible URL credential redaction", () => {
  it.each([
    "key=synthetic_not_a_real_credential_1234567890abcdef",
    "token=short",
    "code=123456",
    "%6bey=synthetic_not_a_real_credential_1234567890abcdef",
    "signature=first&safe=kept&signature=second",
  ])("labels unusable model-visible URL credentials: %s", (query) => {
    const input = `https://example.test/login?${query}&page=2#section`;
    const expected = input.replace(
      /([?&](?:key|token|code|%6bey|signature)=)[^&#]*/g,
      "$1REDACTED_SECRET_DO_NOT_USE",
    );
    for (const config of [undefined, withFullContextToolPayloadRedaction({})]) {
      const result = redactModelVisibleToolPayloadTextWithConfig(input, config);
      expect(result).toBe(expected);
      expect(redactModelVisibleToolPayloadTextWithConfig(result, config)).toBe(expected);
      expect(redactModelVisibleSensitiveFieldValueWithConfig("text", input, config)).toBe(expected);
    }
    expect(
      redactModelVisibleSecrets({ content: [{ text: input }], details: { url: input } }),
    ).toEqual({
      content: [{ text: expected }],
      details: { url: expected },
    });
  });

  it("keeps explicit URL markers inside serialized and quoted results without changing diagnostics", () => {
    const url = "https://example.test/login?key=synthetic_not_a_real_credential_1234567890abcdef";
    const maskedUrl = "https://example.test/login?key=REDACTED_SECRET_DO_NOT_USE";
    for (const [input, expected] of [
      [JSON.stringify({ url }), JSON.stringify({ url: maskedUrl })],
      [`<a href="${url}">login</a>`, `<a href="${maskedUrl}">login</a>`],
      [`[login](${url})`, `[login](${maskedUrl})`],
    ] as const) {
      expect(redactModelVisibleToolPayloadText(input)).toBe(expected);
    }
    expect(redactToolPayloadTextWithConfig(url)).toBe("https://example.test/login?key=synthe…cdef");
    const publicUrl = "https://example.test/posts/123?page=2&sort=newest#details";
    expect(redactModelVisibleToolPayloadText(publicUrl)).toBe(publicUrl);
  });
});
