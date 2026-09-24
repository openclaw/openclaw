// Covers runtime snapshot writes produced by config IO.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectConfigOntoRuntimeSourceSnapshot,
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import { replaceConfigFile, type ConfigMutationIO } from "./mutate.js";
import {
  registerManagedRuntimeConfigWriteOwner,
  registerRuntimeConfigWriteListener,
  type RuntimeConfigWriteNotification,
  type RuntimeConfigWritePreparedCandidate,
} from "./runtime-snapshot.js";
import { createProviderConfigFixture } from "./runtime-snapshot.test-fixtures.js";
import { withTempHomeConfig } from "./test-helpers.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

function resetRuntimeConfigState(): void {
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
}

describe("runtime config snapshot writes", () => {
  beforeEach(() => {
    resetRuntimeConfigState();
  });

  afterEach(() => {
    resetRuntimeConfigState();
  });

  it("skips source projection for non-runtime-derived configs", () => {
    const sourceConfig: OpenClawConfig = {
      ...createProviderConfigFixture(),
      gateway: {
        auth: {
          mode: "token",
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      ...createProviderConfigFixture("sk-runtime-resolved"), // pragma: allowlist secret
      gateway: {
        auth: {
          mode: "token",
        },
      },
    };
    const independentConfig = createProviderConfigFixture("sk-independent-config"); // pragma: allowlist secret

    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    const projected = projectConfigOntoRuntimeSourceSnapshot(independentConfig);
    expect(projected).toBe(independentConfig);
  });

  it("isolates untouched source descendants when projecting runtime edits", () => {
    const sourceConfig: OpenClawConfig = {
      ...createProviderConfigFixture(),
      gateway: { mode: "local", port: 19001 },
      tools: { exec: { safeBins: ["jq"] } },
    };
    const runtimeConfig: OpenClawConfig = {
      ...sourceConfig,
      ...createProviderConfigFixture("synthetic-runtime-value"),
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    const projected = projectConfigOntoRuntimeSourceSnapshot({
      ...runtimeConfig,
      gateway: { ...runtimeConfig.gateway, port: 19002 },
    });
    const safeBins = projected.tools?.exec?.safeBins;
    if (!safeBins) {
      throw new Error("expected projected safe bins");
    }
    safeBins.push("cut");
    expect(sourceConfig.tools?.exec?.safeBins).toEqual(["jq"]);
    expect(projected.models).toEqual(sourceConfig.models);
    expect(projected.gateway?.port).toBe(19002);
  });

  it("retains an empty object for a changed runtime subtree", () => {
    const sourceConfig: OpenClawConfig = { gateway: { port: 18789 } };
    const runtimeConfig: OpenClawConfig = {
      gateway: { port: 18789, auth: { mode: "token", allowTailscale: true } },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const projected = projectConfigOntoRuntimeSourceSnapshot({
      gateway: { port: 18789, auth: { mode: "token" } },
    });

    expect(projected).toStrictEqual({ gateway: { port: 18789, auth: {} } });
  });

  it("preserves literal nulls and omissions when projecting a runtime edit", () => {
    const sourceConfig: OpenClawConfig = {
      ...createProviderConfigFixture(),
      agents: { defaults: { params: { temperature: 0.2, topP: 0.8 } } },
    };
    const runtimeConfig: OpenClawConfig = {
      ...createProviderConfigFixture("synthetic-runtime-value"),
      agents: { defaults: { ...sourceConfig.agents?.defaults, maxConcurrent: 4 } },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    const params = { temperature: null, nested: { value: null } };

    const projected = projectConfigOntoRuntimeSourceSnapshot({
      ...runtimeConfig,
      agents: { defaults: { ...runtimeConfig.agents?.defaults, params } },
    });

    expect(projected).toStrictEqual({
      ...sourceConfig,
      agents: { defaults: { params } },
    });
  });

  it("preserves auth-store refresh scope through managed preflight and notification", async () => {
    const initialConfig = {
      gateway: { mode: "local" as const },
      logging: { level: "info" as const },
    } satisfies OpenClawConfig;
    await withTempHomeConfig(initialConfig, async ({ configPath }) => {
      const overlayCalls: Array<{
        kind: string;
        receiver: RuntimeConfigWritePreparedCandidate;
        config: OpenClawConfig;
      }> = [];
      let prepared: RuntimeConfigWritePreparedCandidate | undefined;
      const preflight = vi.fn(
        async (
          sourceConfig: OpenClawConfig,
          refreshOptions?: { includeAuthStoreRefs?: boolean },
        ) => {
          prepared = {
            runtimeConfig: sourceConfig,
            compareConfig: sourceConfig,
            reapplyRuntimeOverlays(config) {
              overlayCalls.push({ kind: "runtime", receiver: this, config });
              return { ...config, logging: { level: "warn" } };
            },
            reapplyCompareOverlays(config) {
              overlayCalls.push({ kind: "compare", receiver: this, config });
              return { ...config, logging: { level: "error" } };
            },
          };
          return Object.assign(prepared, { refreshOptions });
        },
      );
      const notifications: Array<
        Omit<RuntimeConfigWriteNotification, "preparedCandidatesByOwner">
      > = [];
      const unsubscribe = registerConfigWriteListener((event) => notifications.push(event), {
        ownsRuntimeActivationFor: configPath,
        preCommitRuntimePreflight: preflight,
      });
      try {
        setRuntimeConfigSnapshot(initialConfig, initialConfig);
        await writeConfigFile(
          { ...initialConfig, logging: { level: "debug" } },
          { runtimeRefresh: { includeAuthStoreRefs: false } },
        );
      } finally {
        unsubscribe();
      }
      expect(preflight).toHaveBeenCalledWith(expect.any(Object), {
        includeAuthStoreRefs: false,
      });
      expect(notifications).toHaveLength(1);
      const [notification] = notifications;
      expect(notification?.runtimeRefresh).toEqual({ includeAuthStoreRefs: false });
      expect(overlayCalls.map(({ kind }) => kind)).toEqual(["runtime", "compare"]);
      expect(overlayCalls.map(({ config }) => config)).toEqual([
        notification?.runtimeConfig,
        notification?.sourceConfig,
      ]);
      for (const { receiver } of overlayCalls) {
        expect(receiver).toBe(prepared);
      }
      expect(notification?.preparedCandidate).not.toBe(prepared);
      expect(notification?.preparedCandidate?.runtimeConfig.logging?.level).toBe("warn");
      expect(notification?.preparedCandidate?.compareConfig.logging?.level).toBe("error");
      expect(prepared?.runtimeConfig.logging?.level).toBe("debug");
      expect(prepared?.compareConfig.logging?.level).toBe("debug");
    });
  });

  it("rolls back a managed root write when a notification overlay throws", async () => {
    const initialConfig = {
      gateway: { mode: "local" as const },
      logging: { level: "info" as const },
    };
    await withTempHomeConfig(initialConfig, async ({ configPath }) => {
      const originalRaw = await fs.readFile(configPath, "utf-8");
      const failure = new Error("synthetic overlay failure");
      const listener = vi.fn();
      const compareOverlay = vi.fn((config: OpenClawConfig) => config);
      const unsubscribe = registerConfigWriteListener(listener, {
        ownsRuntimeActivationFor: configPath,
        preCommitRuntimePreflight: async (sourceConfig) => ({
          runtimeConfig: sourceConfig,
          compareConfig: sourceConfig,
          reapplyRuntimeOverlays() {
            throw failure;
          },
          reapplyCompareOverlays: compareOverlay,
        }),
      });
      try {
        setRuntimeConfigSnapshot(initialConfig, initialConfig);
        const pending = writeConfigFile({ ...initialConfig, logging: { level: "debug" } });
        await expect(pending).rejects.toMatchObject({
          name: "ConfigWritePostCommitError",
          rollbackStatus: "restored",
          cause: failure,
        });
        const error = await pending.catch((caught: unknown) => caught);
        expect(error instanceof Error ? error.cause : undefined).toBe(failure);
      } finally {
        unsubscribe();
      }
      expect(listener).not.toHaveBeenCalled();
      expect(compareOverlay).not.toHaveBeenCalled();
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
    });
  });

  it("preserves auth-store refresh scope for managed top-level include writes", async () => {
    const authoredRoot = { plugins: { $include: "./config/plugins.json5" } };
    await withTempHomeConfig(authoredRoot, async ({ configPath }) => {
      const pluginsPath = path.join(path.dirname(configPath), "config", "plugins.json5");
      await fs.mkdir(path.dirname(pluginsPath), { recursive: true });
      await fs.writeFile(pluginsPath, `${JSON.stringify({ entries: {} }, null, 2)}\n`, "utf-8");
      const raw = await fs.readFile(configPath, "utf-8");
      const initialConfig = { plugins: { entries: {} } };
      const snapshot: ConfigFileSnapshot = {
        path: configPath,
        exists: true,
        raw,
        parsed: authoredRoot,
        sourceConfig: initialConfig,
        resolved: initialConfig,
        valid: true,
        runtimeConfig: initialConfig,
        config: initialConfig,
        hash: hashConfigRaw(raw),
        issues: [],
        warnings: [],
        legacyIssues: [],
      };
      const nextConfig = {
        plugins: { entries: { demo: { enabled: true } } },
      } satisfies OpenClawConfig;
      const nextRuntimeConfig = { ...nextConfig, logging: { level: "debug" as const } };
      // Control only the canonical reread; the include file is contained, hashed and written normally.
      const io = {
        readConfigFileSnapshotForWrite: vi.fn(async () => ({
          snapshot: {
            ...snapshot,
            sourceConfig: nextConfig,
            runtimeConfig: nextRuntimeConfig,
            config: nextRuntimeConfig,
          },
          writeOptions: { expectedConfigPath: configPath },
        })),
        writeConfigFile: vi.fn<ConfigMutationIO["writeConfigFile"]>(),
      } satisfies ConfigMutationIO;
      const overlayCalls: Array<[string, RuntimeConfigWritePreparedCandidate, OpenClawConfig]> = [];
      const metadata = Symbol("prepared metadata");
      const prepared = {
        runtimeConfig: snapshot.runtimeConfig,
        compareConfig: snapshot.sourceConfig,
        [metadata]: "preserved",
        reapplyRuntimeOverlays(config: OpenClawConfig): OpenClawConfig {
          overlayCalls.push(["runtime", this, config]);
          return { ...config, logging: { level: "warn" } };
        },
        reapplyCompareOverlays(config: OpenClawConfig): OpenClawConfig {
          overlayCalls.push(["compare", this, config]);
          return { ...config, logging: { level: "error" } };
        },
      };
      const fallback = {
        runtimeConfig: snapshot.runtimeConfig,
        compareConfig: snapshot.sourceConfig,
      };
      const preflight = vi.fn(
        async (
          _sourceConfig: OpenClawConfig,
          refreshOptions?: { includeAuthStoreRefs?: boolean },
        ) => {
          if (refreshOptions?.includeAuthStoreRefs !== false) {
            throw new Error("unavailable auth-profile SecretRef");
          }
          return prepared;
        },
      );
      const releaseOwner = registerManagedRuntimeConfigWriteOwner(configPath, preflight);
      const releaseFallback = registerManagedRuntimeConfigWriteOwner(
        configPath,
        async () => fallback,
      );
      const notifications: RuntimeConfigWriteNotification[] = [];
      const releaseListener = registerRuntimeConfigWriteListener((event) => {
        if (event.configPath === configPath) {
          notifications.push(event);
        }
      });
      try {
        await replaceConfigFile({
          baseHash: snapshot.hash ?? undefined,
          snapshot,
          writeOptions: {
            expectedConfigPath: configPath,
            assertConfigPathForWrite: () => {},
            includeFileTargetsForWrite: { [pluginsPath]: await fs.realpath(pluginsPath) },
            runtimeRefresh: { includeAuthStoreRefs: false },
          },
          nextConfig,
          io,
        });
      } finally {
        releaseListener();
        releaseFallback();
        releaseOwner();
      }
      expect(io.writeConfigFile).not.toHaveBeenCalled();
      expect(preflight).toHaveBeenCalledWith(expect.any(Object), { includeAuthStoreRefs: false });
      expect(notifications).toHaveLength(1);
      const [notification] = notifications;
      expect(notification?.runtimeRefresh).toEqual({ includeAuthStoreRefs: false });
      const candidates = notification?.preparedCandidatesByOwner;
      expect([...(candidates?.keys() ?? [])]).toEqual([
        releaseOwner.ownerId,
        releaseFallback.ownerId,
      ]);
      expect(overlayCalls).toEqual([
        ["runtime", prepared, nextRuntimeConfig],
        ["compare", prepared, nextConfig],
      ]);
      for (const [, receiver] of overlayCalls) {
        expect(receiver).toBe(prepared);
      }
      const projected = candidates?.get(releaseOwner.ownerId);
      expect(projected).not.toBe(prepared);
      expect(projected).toMatchObject({ [metadata]: "preserved" });
      expect(projected?.runtimeConfig.logging?.level).toBe("warn");
      expect(projected?.compareConfig.logging?.level).toBe("error");
      expect(prepared.runtimeConfig).toBe(snapshot.runtimeConfig);
      expect(prepared.compareConfig).toBe(snapshot.sourceConfig);
      const unchanged = candidates?.get(releaseFallback.ownerId);
      expect(unchanged).not.toBe(fallback);
      expect(unchanged?.runtimeConfig).toBe(fallback.runtimeConfig);
      expect(unchanged?.compareConfig).toBe(fallback.compareConfig);
      const persisted = JSON.parse(
        await fs.readFile(pluginsPath, "utf-8"),
      ) as OpenClawConfig["plugins"];
      expect(persisted?.entries?.demo?.enabled).toBe(true);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(raw);
    });
  });
});
