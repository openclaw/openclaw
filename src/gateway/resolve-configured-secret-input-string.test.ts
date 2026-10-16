import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { coerceConfig, resolveConfigForRead } from "../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.js";
import { withMockedWindowsAclVerificationUnavailable } from "../test-utils/vitest-spies.js";
import {
  resolveCanonicalConfiguredSecretInputString,
  resolveCanonicalConfiguredSecretInputWithFallback,
  resolveCanonicalRequiredConfiguredSecretRefInputString,
} from "./resolve-configured-secret-input-string.js";

let fixtureRoot = "";

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-secret-input-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

function createConfig(value: unknown): OpenClawConfig {
  return {
    gateway: { auth: { token: value } },
    secrets: { providers: { default: { source: "env" } } },
  } as OpenClawConfig;
}

async function createWindowsAclUnavailableConfig() {
  const filePath = path.join(fixtureRoot, "gateway-token.txt");
  await fs.writeFile(filePath, "secret-token", { mode: 0o600 });
  return {
    filePath,
    config: {
      gateway: { auth: { token: { source: "file", provider: "filemain", id: "value" } } },
      secrets: {
        providers: {
          filemain: { source: "file", path: filePath, mode: "singleValue" },
        },
      },
    } as OpenClawConfig,
  };
}

type FallbackOptions = Parameters<typeof resolveCanonicalConfiguredSecretInputWithFallback>[0];
function secretInput(value: unknown, overrides: Partial<FallbackOptions> = {}): FallbackOptions {
  return { config: createConfig(value), env: {}, value, path: "gateway.auth.token", ...overrides };
}

function resolveFallback(value: unknown, overrides: Partial<FallbackOptions> = {}) {
  return resolveCanonicalConfiguredSecretInputWithFallback(secretInput(value, overrides));
}

function readPluginConfig(entries: unknown) {
  const read = resolveConfigForRead({ plugins: { entries } }, {});
  const config = coerceConfig(read.resolvedConfigRaw);
  setConfigResolutionFacts(config, read.resolutionFacts);
  return config;
}

async function windowsAclResult(unresolvedReasonStyle?: FallbackOptions["unresolvedReasonStyle"]) {
  return withMockedWindowsAclVerificationUnavailable(
    path.join(fixtureRoot, "missing-windows-system-root"),
    async () => {
      const { config, filePath } = await createWindowsAclUnavailableConfig();
      const resolved = await resolveFallback(config.gateway?.auth?.token, {
        config,
        unresolvedReasonStyle,
      });
      return { ...resolved, filePath };
    },
  );
}

describe("resolveCanonicalConfiguredSecretInputWithFallback", () => {
  it("returns plaintext config value when present", async () => {
    const resolved = await resolveFallback("config-token", { readFallback: () => "env-token" });
    expect(resolved).toEqual({
      value: "config-token",
      source: "config",
      secretRefConfigured: false,
    });
  });

  it("ignores blank fallback values when no SecretRef is configured", async () => {
    const resolved = await resolveFallback("", { readFallback: () => "   " });
    expect(resolved).toEqual({ secretRefConfigured: false });
  });

  it("normalizes fallback values when no SecretRef is configured", async () => {
    const resolved = await resolveFallback("", { readFallback: () => "  env-token  " });
    expect(resolved).toEqual({
      value: "env-token",
      source: "fallback",
      secretRefConfigured: false,
    });
  });

  it("returns resolved SecretRef value with fallback metadata", async () => {
    const resolved = await resolveFallback("${CUSTOM_GATEWAY_TOKEN}", {
      env: { CUSTOM_GATEWAY_TOKEN: "resolved-token" },
      readFallback: () => undefined,
    });
    expect(resolved).toEqual({
      value: "resolved-token",
      source: "secretRef",
      secretRefConfigured: true,
    });
  });

  it.each([
    { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
    { source: "file", provider: "missingfile", id: "value" },
    { source: "exec", provider: "missingexec", id: "gateway/token" },
    { source: "store", provider: "missingstore", id: "MISSING_GATEWAY_TOKEN" },
  ] as const)(
    "never reads fallback credentials after an unresolved $source SecretRef",
    async (ref) => {
      const fallbackCredential = "fallback-secret-must-not-be-read-or-disclosed";
      const readFallback = vi.fn(() => fallbackCredential);
      const resolved = await resolveFallback(ref, { readFallback });
      expect(readFallback).not.toHaveBeenCalled();
      expect(resolved).toEqual({
        unresolvedRefReason: `gateway.auth.token SecretRef is unresolved (${ref.source}:${ref.provider}:${ref.id}).`,
        secretRefConfigured: true,
      });
      expect(resolved.unresolvedRefReason).not.toContain(fallbackCredential);
    },
  );

  it("keeps generic Windows ACL failures byte-compatible", async () => {
    expect((await windowsAclResult()).unresolvedRefReason).toBe(
      "gateway.auth.token SecretRef is unresolved (file:filemain:value).",
    );
  });

  it("adds only the sanitized Windows ACL diagnostic in detailed mode", async () => {
    const resolved = await windowsAclResult("detailed");
    expect(resolved.unresolvedRefReason).toBe(
      "gateway.auth.token SecretRef is unresolved (file:filemain:value). Windows path security could not be verified. Restore Windows path security verification, or use an existing secret file whose owner and ACLs OpenClaw can verify.",
    );
    expect(resolved.unresolvedRefReason).not.toContain(resolved.filePath);
  });

  it("keeps unrelated detailed provider failures unchanged", async () => {
    const resolved = await resolveFallback("${MISSING_GATEWAY_TOKEN}", {
      unresolvedReasonStyle: "detailed",
    });
    expect(resolved.unresolvedRefReason).toBe(
      "gateway.auth.token SecretRef is unresolved (env:default:MISSING_GATEWAY_TOKEN).",
    );
  });
});

describe("resolveCanonicalRequiredConfiguredSecretRefInputString", () => {
  it("returns undefined when no SecretRef is configured", async () => {
    const value = await resolveCanonicalRequiredConfiguredSecretRefInputString(
      secretInput("plain-token"),
    );
    expect(value).toBeUndefined();
  });

  it("returns resolved SecretRef value when required", async () => {
    const value = await resolveCanonicalRequiredConfiguredSecretRefInputString(
      secretInput("${CUSTOM_GATEWAY_TOKEN}", { env: { CUSTOM_GATEWAY_TOKEN: "resolved-token" } }),
    );
    expect(value).toBe("resolved-token");
  });

  it("throws when SecretRef cannot be resolved", async () => {
    await expect(
      resolveCanonicalRequiredConfiguredSecretRefInputString(
        secretInput("${MISSING_GATEWAY_TOKEN}"),
      ),
    ).rejects.toThrow(/MISSING_GATEWAY_TOKEN/i);
  });
});

describe("resolveCanonicalConfiguredSecretInputString target identity", () => {
  it.each([
    { path: 'plugins.entries.fixture.config["simple"]', id: "SIMPLE_TOKEN" },
    { path: 'plugins.entries.fixture.config["constructor"]', id: "CONSTRUCTOR_TOKEN" },
    { path: 'plugins.entries.fixture.config["prototype"]', id: "PROTOTYPE_TOKEN" },
    { path: 'plugins.entries.fixture.config["0"]', id: "OBJECT_TOKEN" },
    { path: "plugins.entries.fixture.config.0", id: "OBJECT_TOKEN" },
    { path: "plugins.entries.fixture.config.list[0]", id: "ARRAY_TOKEN" },
    { path: "plugins.entries.fixture.config.list.0", id: "ARRAY_TOKEN" },
  ])("resolves the actual config target at $path", async ({ path: configPath, id }) => {
    const config = readPluginConfig({
      fixture: {
        config: {
          simple: "${SIMPLE_TOKEN}",
          constructor: "${CONSTRUCTOR_TOKEN}",
          prototype: "${PROTOTYPE_TOKEN}",
          "0": "${OBJECT_TOKEN}",
          list: ["${ARRAY_TOKEN}"],
        },
      },
    });

    const resolved = await resolveCanonicalConfiguredSecretInputString({
      config,
      env: {},
      value: `\${${id}}`,
      path: configPath,
    });

    expect(resolved.value).toBeUndefined();
    expect(resolved.unresolvedRefReason).toContain(`env:default:${id}`);
  });

  it.each([true, false])(
    "keeps a literal target separate from a neighboring reference (available: %s)",
    async (available) => {
      const config = readPluginConfig({
        "foo.config.bar": { config: { token: "${SOURCE_A}" } },
        foo: { config: { bar: { config: { token: "B_LITERAL" } } } },
      });
      const env = available ? { SOURCE_A: "A_REFERENCE" } : {};
      const reference = await resolveCanonicalConfiguredSecretInputString({
        config,
        env,
        value: "${SOURCE_A}",
        path: 'plugins.entries["foo.config.bar"].config.token',
      });
      const literal = await resolveCanonicalConfiguredSecretInputString({
        config,
        env,
        value: "B_LITERAL",
        path: "plugins.entries.foo.config.bar.config.token",
      });

      expect(literal).toEqual({ value: "B_LITERAL" });
      if (available) {
        expect(reference).toEqual({ value: "A_REFERENCE" });
      } else {
        expect(reference.value).toBeUndefined();
        expect(reference.unresolvedRefReason).toContain("env:default:SOURCE_A");
      }
    },
  );
});
