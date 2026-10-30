import { describe, expect, it, vi } from "vitest";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveConfiguredSecretInputString,
  resolveConfiguredSecretInputWithFallback,
  resolveRequiredConfiguredSecretRefInputString,
} from "./secret-input-runtime.js";

describe("configured SecretInput SDK compatibility", () => {
  it("retains providerless input on all three public resolvers", async () => {
    const params = {
      config: { secrets: { defaults: { env: "plugin-env" } } },
      value: { source: "env", id: "SYNTHETIC_SDK_TOKEN" },
      env: { SYNTHETIC_SDK_TOKEN: "synthetic-sdk-value" },
      path: "plugin credential",
    };
    await expect(resolveConfiguredSecretInputString(params)).resolves.toEqual({
      value: "synthetic-sdk-value",
    });
    await expect(resolveConfiguredSecretInputWithFallback(params)).resolves.toEqual({
      value: "synthetic-sdk-value",
      source: "secretRef",
      secretRefConfigured: true,
    });
    await expect(resolveRequiredConfiguredSecretRefInputString(params)).resolves.toBe(
      "synthetic-sdk-value",
    );
    expect(params.value).toEqual({ source: "env", id: "SYNTHETIC_SDK_TOKEN" });
  });

  it("does not replace an unavailable providerless ref with fallback credentials", async () => {
    const readFallback = vi.fn(() => "synthetic-fallback");
    const result = await resolveConfiguredSecretInputWithFallback({
      config: {},
      value: { source: "env", id: "SYNTHETIC_SDK_MISSING_TOKEN" },
      env: {},
      path: "plugin credential",
      readFallback,
    });
    expect(result).toMatchObject({
      secretRefConfigured: true,
      unresolvedRefReason: expect.any(String),
    });
    expect(result.value).toBeUndefined();
    expect(readFallback).not.toHaveBeenCalled();
  });

  it("preserves materialized literal strings that resemble environment shorthand", async () => {
    const config: OpenClawConfig = {};
    setConfigResolutionFacts(config, new Set());
    await expect(
      resolveConfiguredSecretInputString({
        config,
        value: "$SYNTHETIC_SDK_TOKEN",
        env: { SYNTHETIC_SDK_TOKEN: "synthetic-reparsed-value" },
        path: "plugin credential",
      }),
    ).resolves.toEqual({ value: "$SYNTHETIC_SDK_TOKEN" });
  });
});
