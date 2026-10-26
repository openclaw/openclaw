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

  it("selects array-backed fetch config by identity", () => {
    const fetch: unknown[] = [];
    const web = Object.assign([], { fetch, search: { provider: "not-selected" } });
    expect(resolveWebProviderConfig({ tools: { web } }, "fetch")).toBe(fetch);
    expect(resolveWebProviderConfig(undefined, "fetch")).toBeUndefined();
  });

  it.each([undefined, null, false, 1, "text", () => ({})])(
    "rejects non-object selected tool config: %j",
    (search) => {
      expect(resolveWebProviderConfig({ tools: { web: { search } } }, "search")).toBeUndefined();
    },
  );
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

  it("continues past normalized-empty values and keeps the first usable entry", () => {
    const values = { EMPTY: " \0🙂 ", FIRST: " first ", SECOND: "second" };
    expect(readWebProviderEnvValue(["MISSING", "EMPTY", "FIRST", "SECOND"], values)).toBe("first");
    expect(readWebProviderEnvValue(["MISSING", "EMPTY"], values)).toBeUndefined();
  });
});

describe("hasWebProviderEntryCredential", () => {
  type Params = Parameters<typeof hasWebProviderEntryCredential>[0];
  type Overrides = Omit<Partial<Params>, "provider"> & { provider?: Partial<Params["provider"]> };
  const hasCredential = (raw: unknown, { provider, ...overrides }: Overrides = {}) =>
    hasWebProviderEntryCredential({
      config: {},
      resolveEnvValue: () => undefined,
      ...overrides,
      provider: {
        envVars: ["CUSTOM_API_KEY"],
        getConfiguredCredentialValue: () => raw,
        ...provider,
      },
    });

  it("treats non-env secret refs as configured credentials", () => {
    const ref = { source: "file", provider: "mounted-json", id: "/custom/apiKey" };
    expect(hasCredential(ref)).toBe(true);
  });

  it("resolves env secret ref ids through the env resolver", () => {
    const ref = { source: "env", provider: "default", id: "CUSTOM_API_KEY" };
    expect(
      hasCredential(ref, {
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
      hasCredential(raw, {
        provider: {
          getConfiguredCredentialFallback:
            fallback === undefined ? undefined : () => ({ value: fallback, path: "custom.apiKey" }),
        },
      }),
    ).toBe(false);
  });

  it("keeps non-reference config strings as literal credentials", () => {
    expect(hasCredential("literal-secret")).toBe(true);
  });

  it.each([
    [" \0🙂 ", false],
    [" café \r\n", true],
  ] as const)("normalizes primary and fallback literals %j", (value, expected) => {
    expect(hasCredential(value)).toBe(expected);
    expect(
      hasCredential(undefined, {
        provider: { getConfiguredCredentialFallback: () => ({ value, path: "custom.apiKey" }) },
      }),
    ).toBe(expected);
  });

  it("accepts provider auth when no key is configured", () => {
    expect(
      hasCredential(undefined, {
        provider: { authProviderId: "custom-auth" },
        resolveProviderAuthValue: (providerId) => providerId === "custom-auth",
      }),
    ).toBe(true);
  });
});
