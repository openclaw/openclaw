// Test helpers for command runtime/config fixtures.
// Kept under commands because many command tests need the same mock runtime shapes.

import { vi } from "vitest";
import type { ConfigMutationResult } from "../config/mutate.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { InstallOwner } from "../infra/install-owner.js";
import type { RuntimeEnv } from "../runtime.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";

export function createMacosAppInstallOwner(): InstallOwner {
  return {
    schemaVersion: 1,
    owner: "macos-app",
    displayName: "OpenClaw.app",
    updateHint: "Update OpenClaw.app to update this Gateway.",
  };
}

export const MACOS_APP_INSTALL_OWNER_MARKER = JSON.stringify(createMacosAppInstallOwner());

export const baseConfigSnapshot = {
  path: "/tmp/openclaw.json",
  exists: true,
  raw: "{}",
  parsed: {},
  valid: true,
  config: {},
  issues: [],
  legacyIssues: [],
};

export function createPluginPackagingConfigIssues(): Pick<
  ConfigFileSnapshot,
  "issues" | "warnings"
> {
  return {
    issues: [{ path: "plugins.slots.memory", message: "plugin not found: source-only-pack" }],
    warnings: [
      {
        path: "plugins",
        message:
          "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js. This is a plugin packaging issue, not a local config problem.",
      },
    ],
  };
}

export function createTestModelDefinition(
  id: string,
  overrides: Partial<ModelDefinitionConfig> = {},
): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 4096,
    ...overrides,
  };
}

/** Builds a complete config snapshot while preserving distinct authored and runtime fixtures. */
export function createTestConfigSnapshot(
  sourceConfig: OpenClawConfig,
  runtimeConfig: OpenClawConfig = sourceConfig,
  configPath = "/tmp/openclaw.json",
): ConfigFileSnapshot {
  // SAFETY: Snapshot source branding preserves the exact caller-owned authored config object.
  const resolvedSourceConfig = sourceConfig as ConfigFileSnapshot["sourceConfig"];
  // SAFETY: Snapshot runtime branding preserves the distinct caller-owned runtime config object.
  const resolvedRuntimeConfig = runtimeConfig as ConfigFileSnapshot["runtimeConfig"];
  return {
    path: configPath,
    exists: true,
    raw: "{}",
    parsed: {},
    sourceConfig: resolvedSourceConfig,
    resolved: resolvedSourceConfig,
    valid: true,
    runtimeConfig: resolvedRuntimeConfig,
    config: resolvedRuntimeConfig,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

/** Virtual file ownership for command tests that keep the real post-write hook dispatcher. */
export function createTestConfigFileStore() {
  const snapshots = new Map<string, ConfigFileSnapshot>();
  return {
    write(next: OpenClawConfig, configPath = "/tmp/openclaw.json"): ConfigMutationResult<void> {
      const nextConfig = structuredClone(next);
      const snapshot = createTestConfigSnapshot(nextConfig, nextConfig, configPath);
      snapshots.set(configPath, snapshot);
      return {
        path: configPath,
        result: undefined,
        attempts: 1,
        previousHash: null,
        persistedHash: "test-config-hash",
        snapshot,
        nextConfig,
        afterWrite: { mode: "auto" },
        followUp: { mode: "auto", requiresRestart: false },
      };
    },
    read(configPath: string) {
      const snapshot = snapshots.get(configPath);
      if (!snapshot) {
        throw new Error(`No test config was committed to ${configPath}`);
      }
      return { snapshot: structuredClone(snapshot) };
    },
    clear() {
      snapshots.clear();
    },
  };
}

type TestRuntime = {
  log: MockFn<RuntimeEnv["log"]>;
  error: MockFn<RuntimeEnv["error"]>;
  exit: MockFn<RuntimeEnv["exit"]>;
};

type CapturingTestRuntime = {
  runtime: RuntimeEnv;
  logs: string[];
  errors: string[];
};

/** Creates a mocked runtime whose calls can be asserted by Vitest tests. */
export function createTestRuntime(): TestRuntime {
  const log = vi.fn<RuntimeEnv["log"]>();
  const error = vi.fn<RuntimeEnv["error"]>();
  const exit = vi.fn<RuntimeEnv["exit"]>((_code: number) => undefined);
  return {
    log,
    error,
    exit,
  };
}

/** Creates a runtime that captures log/error strings in arrays. */
export function createCapturingTestRuntime(): CapturingTestRuntime {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: (message: unknown) => logs.push(String(message)),
    error: (message: unknown) => errors.push(String(message)),
    exit: (_code?: number) => undefined,
  };
  return { runtime, logs, errors };
}

/** Creates a runtime that throws on exit so tests can assert early termination. */
export function createThrowingTestRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(() => {
      throw new Error("exit");
    }),
  };
}

export function createTestConfigReadMocks<TKey extends string, TArgs extends unknown[], TResult>(
  owner: Record<TKey, (...args: TArgs) => TResult>,
  key: TKey,
) {
  const loadConfig = owner[key];
  return {
    getRuntimeConfig: loadConfig,
    loadConfig,
    captureRuntimeConfigAsyncReader:
      (...args: TArgs) =>
      async () =>
        owner[key](...args),
  };
}
