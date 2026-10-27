import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./config-contracts.js";
import { resolveReadOnlyEnvSecretRef } from "./secret-ref-readonly.js";

type Providers = NonNullable<NonNullable<OpenClawConfig["secrets"]>["providers"]>;
const file = { source: "file", path: "/unused" } satisfies Providers[string];
const config = (env = "default", providers?: Providers): OpenClawConfig => ({
  secrets: { defaults: { env }, providers },
});
const envConfig = (allowlist?: string[]) =>
  config("selected", { selected: { source: "env", allowlist } });
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
afterEach(() => vi.unstubAllEnvs());

it.each([
  ["default shadows file", "default", { secrets: { providers: { default: file } } }, "available"],
  ["selected shadows file", "selected", config("selected", { selected: file }), "available"],
  ["implicit default", "default", {}, "available"],
  ["undeclared selected", "selected", config("selected"), "available"],
  ["undeclared other", "other", {}, "blocked"],
  ["unselected default", "default", config("selected"), "blocked"],
  ["other file", "other", { secrets: { providers: { other: file } } }, "blocked"],
  ["unrestricted env", "selected", envConfig(), "available"],
  ["allowlisted env", "selected", envConfig(["EXPECTED_API_KEY"]), "available"],
  ["empty allowlist", "selected", envConfig([]), "blocked"],
  ["other allowlist", "selected", envConfig(["OTHER_API_KEY"]), "blocked"],
] as const)("enforces provider policy: %s", (_name, provider, cfg, expected) => {
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
  ["file", "/api/key"],
  ["env", "OTHER_API_KEY"],
])("blocks %s:%s before normalizing", (source, id) => {
  vi.stubEnv("EXPECTED_API_KEY", "synthetic-value");
  vi.stubEnv("OTHER_API_KEY", "other-synthetic-value");
  const normalizeValue = vi.fn(() => "must-not-be-used");
  const value = { source, provider: "default", id };
  const cfg = { secrets: { providers: { default: file } } };
  expect(resolve({ value, cfg, normalizeValue })).toEqual({ status: "blocked" });
  expect(normalizeValue).not.toHaveBeenCalled();
});

it.each([
  [undefined, { source: "env" }],
  ["   ", { source: "exec", command: "/unused" }],
] as const)("blocks missing selected env value %s with %j", (value, provider) => {
  vi.stubEnv("EXPECTED_API_KEY", value);
  expect(resolve({ cfg: config("selected", { selected: provider }) })).toEqual({
    status: "blocked",
  });
});

it("keeps an absent credential missing so callers can apply their fallback", () => {
  const normalizeValue = (value: unknown) => (typeof value === "string" ? value : undefined);
  expect(resolve({ value: undefined, normalizeValue })).toEqual({ status: "missing" });
});
