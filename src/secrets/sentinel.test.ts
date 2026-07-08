import { afterEach, describe, expect, it } from "vitest";
import { redactSensitiveText } from "../logging/redact.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.js";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
  SECRET_SENTINEL_PATTERN,
  swapSecretSentinelsInText,
} from "./sentinel.js";

describe("secret sentinels", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_SECRET_SENTINELS;
    resetSecretRedactionRegistryForTest();
  });

  it("mints, recognizes, resolves, and reuses sentinels by value and label", () => {
    const first = mintSecretSentinel("provider-secret-value", { label: "model-auth:openai" });
    const repeated = mintSecretSentinel("provider-secret-value", { label: "model-auth:openai" });
    const otherLabel = mintSecretSentinel("provider-secret-value", { label: "model-auth:other" });

    expect(first).toMatch(/^oc-sent-v1-[0-9a-f]{24}$/);
    expect(first.match(SECRET_SENTINEL_PATTERN)).toEqual([first]);
    expect(looksLikeSecretSentinel(first)).toBe(true);
    expect(resolveSecretSentinel(first)).toBe("provider-secret-value");
    expect(repeated).toBe(first);
    expect(otherLabel).not.toBe(first);
  });

  it("swaps repeated and composed sentinel substrings", () => {
    const first = mintSecretSentinel("first-secret-value", { label: "model-auth:openai" });
    const second = mintSecretSentinel("second-secret-value", { label: "model-auth:cloudflare" });

    expect(
      swapSecretSentinelsInText(`Bearer ${first}; cf-aig-authorization=Bearer ${second}; ${first}`),
    ).toEqual({
      text: "Bearer first-secret-value; cf-aig-authorization=Bearer second-secret-value; first-secret-value",
      unknown: [],
    });
  });

  it("reports unknown sentinel-shaped values without replacing them", () => {
    const unknown = "oc-sent-v1-0123456789abcdef01234567";
    expect(swapSecretSentinelsInText(`Bearer ${unknown}`)).toEqual({
      text: `Bearer ${unknown}`,
      unknown: [unknown],
    });
  });

  it("treats sentinel-shaped bytes inside resolved values as opaque", () => {
    const secret = "prefix-oc-sent-v1-0123456789abcdef01234567";
    const sentinel = mintSecretSentinel(secret, { label: "nested-shape" });

    expect(swapSecretSentinelsInText(`Bearer ${sentinel}`)).toEqual({
      text: `Bearer ${secret}`,
      unknown: [],
    });
  });

  it.each(["off", " OFF ", "0", "false", "False"])(
    "returns plaintext when the kill switch is %s",
    (value) => {
      process.env.OPENCLAW_SECRET_SENTINELS = value;
      expect(mintSecretSentinel("kill-switch-secret", { label: "model-auth:test" })).toBe(
        "kill-switch-secret",
      );
    },
  );

  it("registers minted values for exact redaction across registry eviction", () => {
    const first = "sentinel-registry-value-000";
    const firstSentinel = mintSecretSentinel(first, { label: "model-auth:0" });
    for (let index = 1; index <= 512; index += 1) {
      mintSecretSentinel(`sentinel-registry-value-${index.toString().padStart(3, "0")}`, {
        label: `model-auth:${index}`,
      });
    }
    const last = "sentinel-registry-value-512";

    expect(redactSensitiveText(first, { mode: "tools", patterns: [] })).toBe(first);
    expect(redactSensitiveText(last, { mode: "tools", patterns: [] })).not.toContain(last);
    expect(resolveSecretSentinel(firstSentinel)).toBe(first);
    expect(redactSensitiveText(first, { mode: "tools", patterns: [] })).not.toContain(first);
  });
});
