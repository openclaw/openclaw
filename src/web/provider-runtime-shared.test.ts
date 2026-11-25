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
    (search) =>
      expect(resolveWebProviderConfig({ tools: { web: { search } } }, "search")).toBeUndefined(),
  );
});

const read = (API_KEY: string) => readWebProviderEnvValue(["API_KEY"], { API_KEY });
it("readWebProviderEnvValue strips controls and non-Latin1, preserving ordinary spaces", () => {
  expect(read(" sk-\r\n\u0000ab\tc\u007f\u0085🙂 ")).toBe("sk-abc");
  expect(read(" Bearer token value ")).toBe("Bearer token value");
});

it("readWebProviderEnvValue skips normalized-empty values and keeps the first usable entry", () => {
  const values = { EMPTY: " \0🙂 ", FIRST: " first ", SECOND: "second" };
  expect(readWebProviderEnvValue(["MISSING", "EMPTY", "FIRST", "SECOND"], values)).toBe("first");
  expect(readWebProviderEnvValue(["MISSING", "EMPTY"], values)).toBeUndefined();
});

describe("hasWebProviderEntryCredential", () => {
  type Params = Parameters<typeof hasWebProviderEntryCredential>[0];
  const hasCredential = (
    raw: unknown,
    fallback?: string,
    resolveEnvValue: Params["resolveEnvValue"] = () => undefined,
  ) =>
    hasWebProviderEntryCredential({
      resolveEnvValue,
      provider: {
        envVars: ["CUSTOM_API_KEY"],
        getConfiguredCredentialValue: () => raw,
        getConfiguredCredentialFallback:
          fallback === undefined ? undefined : () => ({ value: fallback, path: "custom.apiKey" }),
      },
    });

  it.each([
    { source: "file", provider: "mounted-json", id: "/custom/apiKey" },
    { source: "env", provider: "default", id: "CUSTOM_API_KEY" },
  ])("accepts $source refs, resolving env refs by id", (ref) =>
    expect(
      hasCredential(ref, undefined, (id) => (id === "CUSTOM_API_KEY" ? "secret" : undefined)),
    ).toBe(true),
  );

  it.each([
    { raw: "${CUSTOM_API_KEY}", fallback: undefined },
    { raw: undefined, fallback: "$CUSTOM_API_KEY" },
    { raw: "secretref-env:CUSTOM_API_KEY", fallback: undefined },
    { raw: undefined, fallback: "__env__:CUSTOM_API_KEY" },
  ])("rejects unresolved or retired refs: raw=$raw, fallback=$fallback", ({ raw, fallback }) => {
    expect(hasCredential(raw, fallback)).toBe(false);
  });

  it.each([
    [" \0🙂 ", false],
    [" café \r\n", true],
  ] as const)("normalizes primary and fallback literals %j", (value, expected) => {
    expect(hasCredential(value)).toBe(expected);
    expect(hasCredential(undefined, value)).toBe(expected);
  });

  it("accepts provider auth when no key is configured", () => {
    expect(
      hasWebProviderEntryCredential({
        provider: { envVars: ["CUSTOM_API_KEY"], authProviderId: "custom-auth" },
        resolveEnvValue: () => undefined,
        resolveProviderAuthValue: (providerId) => providerId === "custom-auth",
      }),
    ).toBe(true);
  });
});
