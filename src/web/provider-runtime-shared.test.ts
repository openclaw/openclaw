import { describe, expect, it } from "vitest";
import {
  hasWebProviderEntryCredential,
  readWebProviderEnvValue,
  resolveWebProviderConfig,
} from "./provider-runtime-shared.js";

describe("resolveWebProviderConfig", () => {
  it("selects the requested web tool config", () => {
    const search = { provider: "search-provider" };

    expect(resolveWebProviderConfig({ tools: { web: { search } } }, "search")).toBe(search);
  });
});

describe("readWebProviderEnvValue", () => {
  it("strips controls and non-Latin1 characters while preserving ordinary spaces", () => {
    expect(
      readWebProviderEnvValue(["API_KEY"], { API_KEY: " sk-\r\n\u0000ab\tc\u007f\u0085🙂 " }),
    ).toBe("sk-abc");
    expect(readWebProviderEnvValue(["API_KEY"], { API_KEY: " Bearer token value " })).toBe(
      "Bearer token value",
    );
  });
});

describe("hasWebProviderEntryCredential", () => {
  const provider = {
    id: "custom",
    envVars: ["CUSTOM_API_KEY"],
  };
  const defaults = {
    provider,
    config: {},
    resolveEnvValue: () => undefined,
  };

  it("treats non-env secret refs as configured credentials", () => {
    expect(
      hasWebProviderEntryCredential({
        ...defaults,
        provider: {
          ...provider,
          getConfiguredCredentialValue: () => ({
            source: "file",
            provider: "mounted-json",
            id: "/custom/apiKey",
          }),
        },
      }),
    ).toBe(true);
  });

  it("resolves env secret ref ids through the env resolver", () => {
    expect(
      hasWebProviderEntryCredential({
        ...defaults,
        provider: {
          ...provider,
          getConfiguredCredentialValue: () => ({
            source: "env",
            provider: "default",
            id: "CUSTOM_API_KEY",
          }),
        },
        resolveEnvValue: (configuredEnvVarId) =>
          configuredEnvVarId === "CUSTOM_API_KEY" ? "secret" : undefined,
      }),
    ).toBe(true);
  });

  it.each([
    { raw: "${CUSTOM_API_KEY}", fallback: undefined },
    { raw: undefined, fallback: "$CUSTOM_API_KEY" },
    { raw: "secretref-env:CUSTOM_API_KEY", fallback: undefined },
    { raw: undefined, fallback: "__env__:CUSTOM_API_KEY" },
  ])("rejects unresolved or retired refs: raw=$raw, fallback=$fallback", ({ raw, fallback }) => {
    expect(
      hasWebProviderEntryCredential({
        ...defaults,
        provider: {
          ...provider,
          getConfiguredCredentialValue: () => raw,
          getConfiguredCredentialFallback:
            fallback === undefined ? undefined : () => ({ value: fallback, path: "custom.apiKey" }),
        },
      }),
    ).toBe(false);
  });

  it("keeps non-reference config strings as literal credentials", () => {
    expect(
      hasWebProviderEntryCredential({
        ...defaults,
        provider: { ...provider, getConfiguredCredentialValue: () => "literal-secret" },
      }),
    ).toBe(true);
  });

  it("accepts provider auth when no key is configured", () => {
    expect(
      hasWebProviderEntryCredential({
        ...defaults,
        provider: {
          ...provider,
          authProviderId: "custom-auth",
        },
        resolveProviderAuthValue: (providerId) => providerId === "custom-auth",
      }),
    ).toBe(true);
  });
});
