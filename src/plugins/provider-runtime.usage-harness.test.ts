import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { clearAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import {
  makeIsolatedEnv,
  makeTempDir,
  resetPluginAutoEnableTestState,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderUsageSnapshotWithPlugin } from "./provider-runtime.js";
import { writeArtifacts } from "./public-surface.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

vi.mock("./provider-hook-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-hook-runtime.js")>();
  return { ...actual, resolveProviderRuntimePlugin: () => undefined };
});

function makeCodexManifestEnv(): NodeJS.ProcessEnv {
  const bundledPluginsDir = path.join(makeTempDir(), "extensions");
  const pluginDir = path.join(bundledPluginsDir, "codex");
  writeArtifacts(pluginDir, {
    "package.json": { name: "@openclaw/codex-test", openclaw: { extensions: ["./index.cjs"] } },
    "openclaw.plugin.json": {
      id: "codex",
      activation: { onAgentHarnesses: ["codex"] },
      configSchema: { type: "object" },
    },
    "index.cjs": `module.exports = {
      id: "codex",
      register(api) {
        api.registerAgentHarness({
          id: "codex",
          label: "Codex",
          supports: () => ({ supported: true }),
          runAttempt: async () => ({ ok: false, error: "unused" }),
          fetchUsageSnapshot: async () => (${JSON.stringify(usageSnapshot)}),
        });
      },
    };\n`,
  });
  return makeIsolatedEnv({ OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir });
}

const usageSnapshot = {
  provider: "openai" as const,
  displayName: "OpenAI",
  windows: [{ label: "5h", usedPercent: 9 }],
};

function usageParams(
  provider = "codex",
  config: OpenClawConfig = {},
  env: NodeJS.ProcessEnv = {},
  workspaceDir = process.cwd(),
) {
  return {
    provider,
    config,
    env,
    workspaceDir,
    context: {
      config,
      env,
      provider: "openai",
      token: "test-token-placeholder",
      timeoutMs: 5_000,
      fetchFn: fetch,
    },
  };
}

afterEach(() => {
  clearAgentHarnesses();
  resetPluginAutoEnableTestState();
  vi.unstubAllEnvs();
});

it("does not reuse an unrelated Gateway registry for cold harness usage", async () => {
  const workspaceDir = makeTempDir();
  const env = makeCodexManifestEnv();

  await expect(
    withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
      resolveProviderUsageSnapshotWithPlugin(usageParams("codex", {}, env, workspaceDir)),
    ),
  ).resolves.toEqual(usageSnapshot);
});

it.each([
  {
    config: { plugins: { enabled: false } } satisfies OpenClawConfig,
    expectedReason: "plugins disabled",
  },
  {
    config: { plugins: { allow: ["openai", "memory-core"] } } satisfies OpenClawConfig,
    expectedReason: "not in allowlist",
  },
])("reports $expectedReason in cold usage diagnostics", async ({ config, expectedReason }) => {
  const workspaceDir = makeTempDir();
  const env = makeCodexManifestEnv();
  for (const key of [
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
  ]) {
    vi.stubEnv(key, env[key] ?? "");
  }

  const error = await resolveProviderUsageSnapshotWithPlugin(
    usageParams("codex", config, env, workspaceDir),
  ).catch((cause: unknown) => cause);

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(expectedReason);
  expect((error as Error).message).toContain("reason=owner-plugin-not-activatable");
  expect((error as Error).message).not.toContain("absent from this prepared plugin generation");
});

it.each([
  ["codex", usageSnapshot],
  ["openai", undefined],
] as const)("routes usage for hook owner %s", async (provider, expected) => {
  const fetchUsageSnapshot = vi.fn(async () => structuredClone(usageSnapshot));
  registerAgentHarness({
    id: provider,
    label: provider === "codex" ? "Codex" : "OpenAI harness",
    supports: () => ({ supported: true }),
    runAttempt: async () => {
      throw new Error("not used");
    },
    fetchUsageSnapshot,
  });
  const snapshot = await resolveProviderUsageSnapshotWithPlugin(usageParams(provider));
  expect(snapshot).toEqual(expected);
  if (provider === "codex") {
    expect(fetchUsageSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", token: "test-token-placeholder" }),
    );
  }
});
