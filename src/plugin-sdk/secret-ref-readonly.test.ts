import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./config-contracts.js";
import { resolveReadOnlyEnvSecretRef } from "./secret-ref-readonly.js";

type SecretProvider = NonNullable<NonNullable<OpenClawConfig["secrets"]>["providers"]>[string];
const collisionProvider = { source: "file", path: "/unused" } satisfies SecretProvider;

describe("resolveReadOnlyEnvSecretRef", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ...["default", "selected"].map((provider) => ({
      name: `${provider} env default shadows file`,
      provider,
      cfg: {
        secrets: {
          defaults: provider === "selected" ? { env: provider } : undefined,
          providers: { [provider]: collisionProvider },
        },
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
      cfg: {
        secrets: {
          defaults: { env: "selected" },
          providers: { selected: { source: "env" as const, allowlist } },
        },
      },
      expected,
    })),
  ])("enforces provider policy: $name", ({ provider, cfg, expected }) => {
    vi.stubEnv("EXPECTED_API_KEY", " synthetic-value ");
    const normalizeValue = vi.fn((value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim() : undefined,
    );

    expect(
      resolveReadOnlyEnvSecretRef({
        value: { source: "env", provider, id: "EXPECTED_API_KEY" },
        path: "plugins.entries.example.config.apiKey",
        cfg,
        expectedEnvId: "EXPECTED_API_KEY",
        normalizeValue,
      }),
    ).toEqual(
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
    expect(
      resolveReadOnlyEnvSecretRef({
        value: { source, provider: "default", id },
        path: "plugins.entries.example.config.apiKey",
        cfg: { secrets: { providers: { default: { source: "file", path: "/unused" } } } },
        expectedEnvId: "EXPECTED_API_KEY",
        normalizeValue,
      }),
    ).toEqual({ status: "blocked" });
    expect(normalizeValue).not.toHaveBeenCalled();
  });

  it.each([
    { value: undefined, source: "env" },
    { value: "   ", source: "exec" },
  ])("blocks missing selected env value $value with a $source declaration", ({ value, source }) => {
    vi.stubEnv("EXPECTED_API_KEY", value);
    expect(
      resolveReadOnlyEnvSecretRef({
        value: { source: "env", provider: "selected", id: "EXPECTED_API_KEY" },
        path: "plugins.entries.example.config.apiKey",
        cfg: {
          secrets: {
            defaults: { env: "selected" },
            providers: {
              selected:
                source === "env" ? { source: "env" } : { source: "exec", command: "/unused" },
            },
          },
        },
        expectedEnvId: "EXPECTED_API_KEY",
        normalizeValue: (input) =>
          typeof input === "string" ? input.trim() || undefined : undefined,
      }),
    ).toEqual({ status: "blocked" });
  });

  it("keeps an absent credential missing so callers can apply their fallback", () => {
    expect(
      resolveReadOnlyEnvSecretRef({
        value: undefined,
        path: "plugins.entries.example.config.apiKey",
        expectedEnvId: "EXPECTED_API_KEY",
        normalizeValue: (value) => (typeof value === "string" ? value : undefined),
      }),
    ).toEqual({ status: "missing" });
  });
});
