import { describe, expect, it } from "vitest";
import { replaceSensitiveValuesInRaw } from "./redact-snapshot.raw.js";

const TEST_REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

describe("replaceSensitiveValuesInRaw", () => {
  it("ignores empty sensitive values while redacting real secrets", () => {
    const raw = JSON.stringify({
      gateway: {
        auth: {
          token: "",
          password: "",
          webhookSecret: "",
        },
      },
      models: {
        providers: {
          openai: {
            apiKey: "sk-secret-value",
          },
        },
      },
      padding: "x".repeat(100_000),
    });

    const result = replaceSensitiveValuesInRaw({
      raw,
      sensitiveValues: ["", "", "", "sk-secret-value"],
      redactedSentinel: TEST_REDACTED_SENTINEL,
    });

    expect(result).toContain(`"apiKey":"${TEST_REDACTED_SENTINEL}"`);
    expect(result).toContain('"token":""');
    expect(result).toContain('"password":""');
    expect(result).toContain('"webhookSecret":""');
  });
});
