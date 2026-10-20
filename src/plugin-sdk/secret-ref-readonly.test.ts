import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./config-contracts.js";
import { resolveReadOnlyEnvSecretRef } from "./secret-ref-readonly.js";

type SecretProvider = NonNullable<NonNullable<OpenClawConfig["secrets"]>["providers"]>[string];
const collisionProvider = { source: "file", path: "/unused" } satisfies SecretProvider;
const normalize = (value: unknown) =>
  typeof value === "string" ? value.trim() || undefined : undefined;
const resolve = (params: Partial<Parameters<typeof resolveReadOnlyEnvSecretRef>[0]>) =>
  resolveReadOnlyEnvSecretRef({
    value: { source: "env", provider: "selected", id: "EXPECTED_API_KEY" },
    path: "plugins.entries.example.config.apiKey",
    expectedEnvId: "EXPECTED_API_KEY",
    normalizeValue: normalize,
    ...params,
  });
const configured = (provider: SecretProvider): OpenClawConfig => ({
  secrets: { defaults: { env: "selected" }, providers: { selected: provider } },
});

describe("resolveReadOnlyEnvSecretRef", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ...["default", "selected"].map((provider) => ({
      name: `${provider} env default shadows file`,
      provider,
      cfg:
        provider === "selected"
          ? configured(collisionProvider)
          : {
              secrets: { providers: { default: collisionProvider } },
            },
      expected: "available",
    })),
    { name: "implicit env default", provider: "default", cfg: {}, expected: "available" },
    {
      name: "undeclared selected env default",
      provider: "selected",
      cfg: { secrets: { defaults: { env: "selected" } } },
      expected: "available",
    },
    { name: "undeclared non-default", provider: "other", cfg: {}, expected: "blocked" },
    {
      name: "literal default is not selected",
      provider: "default",
      cfg: { secrets: { defaults: { env: "selected" } } },
      expected: "blocked",
    },
    {
      name: "non-default file mismatch",
      provider: "other",
      cfg: { secrets: { providers: { other: collisionProvider } } },
      expected: "blocked",
    },
    ...[
      { allowlist: undefined, expected: "available" },
      { allowlist: ["EXPECTED_API_KEY"], expected: "available" },
      { allowlist: [], expected: "blocked" },
      { allowlist: ["OTHER_API_KEY"], expected: "blocked" },
    ].map(({ allowlist, expected }) => ({
      name: `matching env declaration with allowlist ${JSON.stringify(allowlist)}`,
      provider: "selected",
      cfg: configured({ source: "env", allowlist }),
      expected,
    })),
  ])("enforces provider policy: $name", ({ provider, cfg, expected }) => {
    vi.stubEnv("EXPECTED_API_KEY", " synthetic-value ");
    const normalizeValue = vi.fn(normalize);

    const value = { source: "env", provider, id: "EXPECTED_API_KEY" };
    expect(resolve({ value, cfg, normalizeValue })).toEqual(
      expected === "available"
        ? { status: "available", value: "synthetic-value" }
        : { status: "blocked" },
    );
    if (expected === "blocked") {
      expect(normalizeValue).not.toHaveBeenCalled();
    }
  });

  it.each([
    { source: "file", id: "/api/key" },
    { source: "env", id: "OTHER_API_KEY" },
  ])("blocks $source:$id before normalizing any value", ({ source, id }) => {
    vi.stubEnv("EXPECTED_API_KEY", "synthetic-value");
    vi.stubEnv("OTHER_API_KEY", "other-synthetic-value");
    const normalizeValue = vi.fn(() => "must-not-be-used");
    const value = { source, provider: "default", id };
    const cfg = { secrets: { providers: { default: collisionProvider } } };
    expect(resolve({ value, cfg, normalizeValue })).toEqual({ status: "blocked" });
    expect(normalizeValue).not.toHaveBeenCalled();
  });

  it.each([
    { value: undefined, source: "env" },
    { value: "   ", source: "exec" },
  ])("blocks missing selected env value $value with a $source declaration", ({ value, source }) => {
    vi.stubEnv("EXPECTED_API_KEY", value);
    const cfg = configured(
      source === "env" ? { source: "env" } : { source: "exec", command: "/unused" },
    );
    expect(resolve({ cfg })).toEqual({ status: "blocked" });
  });

  it("keeps an absent credential missing so callers can apply their fallback", () => {
    const normalizeValue = (value: unknown) => (typeof value === "string" ? value : undefined);
    expect(resolve({ value: undefined, normalizeValue })).toEqual({ status: "missing" });
  });
});
