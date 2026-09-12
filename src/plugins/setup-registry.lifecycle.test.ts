import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createNonExitingRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  setGatewayPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "./current-plugin-metadata-snapshot.js";
import {
  getGatewayPluginMetadataSnapshot,
  selectCurrentPluginMetadataCache,
} from "./current-plugin-metadata-state.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import {
  createPluginCache,
  getProcessPluginCache,
  getScopedPluginCache,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import {
  clearPluginMetadataLifecycleCaches,
  retainGatewayPluginMetadata,
} from "./plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { getPluginSetupModuleLoader } from "./plugin-setup-module.js";
import { prepareAuthChoiceLoadedPluginProvider } from "./provider-auth-choice.js";
import { detectAvailableSetupProviderIds } from "./provider-setup-availability.js";
import { resolvePluginSetupProviderCore, resolvePluginSetupRegistry } from "./setup-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function writeSetupLifecycleFixture(id: string, body: string) {
  const rootDir = fs.realpathSync(makeTrackedTempDir("setup-lifecycle-owner", tempDirs));
  const source = path.join(rootDir, "setup-api.cjs");
  fs.writeFileSync(source, body);
  return {
    id,
    origin: "config",
    rootDir,
    source,
    setupSource: source,
    manifestPath: path.join(rootDir, "openclaw.plugin.json"),
    channels: [],
    providers: [id],
    cliBackends: [],
    skills: [],
    hooks: [],
    setup: { requiresRuntime: true, providers: [{ id }] },
  } satisfies PluginManifestRegistry["plugins"][number];
}

describe("plugin setup registry artifact lifecycle", () => {
  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    cleanupTrackedTempDirs(tempDirs);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["load", "register"] as const)(
    "records setup %s failures with inaccessible error messages after native evaluation",
    async (phase) => {
      const event = `setup-display-${phase}`;
      const before = process.listenerCount(event);
      const failure = `
        process.on(${JSON.stringify(event)}, () => {});
        const error = new Error("hidden message", { cause: new Error("setup failure detail") });
        Object.defineProperty(error, "message", { get() { throw new Error("display failed"); } });
        throw error;
      `;
      const manifestRegistry: PluginManifestRegistry = {
        plugins: [
          writeSetupLifecycleFixture(
            "setup-display",
            phase === "load" ? failure : `module.exports = { register() { ${failure} } };`,
          ),
        ],
        diagnostics: [],
      };
      const cache = createPluginCache();
      try {
        const result = withPluginCache(cache, () =>
          resolvePluginSetupRegistry({ manifestRegistry }),
        );
        expect(result.providers).toEqual([]);
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            pluginId: "setup-display",
            code: phase === "load" ? "setup-entry-load-failed" : "setup-registration-failed",
            message: expect.stringContaining("setup failure detail"),
          }),
        );
        expect(process.listenerCount(event)).toBe(before + 1);
      } finally {
        await retirePluginCache(cache).finally(() => {
          process.removeAllListeners(event);
        });
      }
    },
  );

  it("records an exported register getter failure without replaying its module", async () => {
    const event = "setup-register-getter";
    const before = process.listenerCount(event);
    const manifestRegistry: PluginManifestRegistry = {
      plugins: [
        writeSetupLifecycleFixture(
          "register-getter",
          `
        process.on(${JSON.stringify(event)}, () => {});
        module.exports = { get register() { throw new Error("register getter failed"); } };
      `,
        ),
      ],
      diagnostics: [],
    };
    const cache = createPluginCache();
    try {
      const result = withPluginCache(cache, () => resolvePluginSetupRegistry({ manifestRegistry }));
      expect(result.providers).toEqual([]);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          pluginId: "register-getter",
          code: "setup-registration-failed",
          message: expect.stringContaining("register getter failed"),
        }),
      );
      await nextTurn();
      expect(process.listenerCount(event)).toBe(before + 1);
    } finally {
      await retirePluginCache(cache).finally(() => {
        process.removeAllListeners(event);
      });
    }
  });

  it("retires a failed setup registration without retiring successful owners in its cache", async () => {
    const ids = ["live-setup", "failed-setup"] as const;
    const event = "setup-registration-owner";
    const cleanupEvent = `${event}-cleanup`;
    const liveBefore = process.listenerCount(`${event}-live-setup`);
    const failedBefore = process.listenerCount(`${event}-failed-setup`);
    const cleaned: string[] = [];
    const observeCleanup = (id: string) => {
      cleaned.push(id);
    };
    process.on(cleanupEvent, observeCleanup);
    const manifestRegistry: PluginManifestRegistry = {
      plugins: ids.map((id) =>
        writeSetupLifecycleFixture(
          id,
          `module.exports = { register(api) {
        const listener = () => {};
        process.on(${JSON.stringify(event)} + "-${id}", listener);
        api.lifecycle.onDispose(() => {
          process.off(${JSON.stringify(event)} + "-${id}", listener);
          process.emit(${JSON.stringify(cleanupEvent)}, "${id}");
        });
        api.registerProvider({ id: "${id}", label: "Setup owner", auth: [], resolveConfigApiKey: () => "ready" });
        ${id === "failed-setup" ? 'throw new Error("registration failed after acquisition");' : ""}
      } };`,
        ),
      ),
      diagnostics: [],
    };
    const cache = createPluginCache();
    try {
      const result = withPluginCache(cache, () => resolvePluginSetupRegistry({ manifestRegistry }));
      expect(result.providers.map((entry) => entry.pluginId)).toEqual(["live-setup"]);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          pluginId: "failed-setup",
          code: "setup-registration-failed",
        }),
      );
      const live = result.providers[0]?.provider;
      expect(live?.resolveConfigApiKey?.({ provider: "live-setup", env: {} })).toBe("ready");
      // Synchronous registration has returned; let its initiated disposal finish before cache teardown.
      await nextTurn();
      expect(process.listenerCount(`${event}-failed-setup`)).toBe(failedBefore);
      expect(cleaned).toEqual(["failed-setup"]);
      expect(process.listenerCount(`${event}-live-setup`)).toBe(liveBefore + 1);
      expect(live?.resolveConfigApiKey?.({ provider: "live-setup", env: {} })).toBe("ready");
    } finally {
      await retirePluginCache(cache);
      process.off(cleanupEvent, observeCleanup);
    }
    expect(ids.map((id) => process.listenerCount(`${event}-${id}`))).toEqual([
      liveBefore,
      failedBefore,
    ]);
    expect(cleaned).toEqual(["failed-setup", "live-setup"]);
  });

  it("preserves an earlier setup registration when its reused module later fails to register", async () => {
    const event = "setup-repeated-registration";
    const cleanupEvent = `${event}-cleanup`;
    const before = process.listenerCount(event);
    const cleaned = vi.fn();
    process.on(cleanupEvent, cleaned);
    const manifestRegistry: PluginManifestRegistry = {
      plugins: [
        writeSetupLifecycleFixture(
          "repeated-setup",
          `let registrations = 0;
        module.exports = { register(api) {
          if (++registrations > 1) throw new Error("later registration failed");
          const listener = () => {};
          process.on(${JSON.stringify(event)}, listener);
          api.lifecycle.onDispose(() => {
            process.off(${JSON.stringify(event)}, listener);
            process.emit(${JSON.stringify(cleanupEvent)});
          });
          api.registerProvider({ id: "repeated-setup", label: "Repeated setup", auth: [],
            resolveConfigApiKey: () => "ready:" + registrations,
          });
        } };`,
        ),
      ],
      diagnostics: [],
    };
    const cache = createPluginCache();
    try {
      const first = withPluginCache(cache, () => resolvePluginSetupRegistry({ manifestRegistry }));
      const retained = first.providers[0]?.provider;
      expect(retained?.resolveConfigApiKey?.({ provider: "repeated-setup", env: {} })).toBe(
        "ready:1",
      );
      const second = withPluginCache(cache, () => resolvePluginSetupRegistry({ manifestRegistry }));
      expect(second.providers).toEqual([]);
      expect(second.diagnostics).toContainEqual(
        expect.objectContaining({
          pluginId: "repeated-setup",
          code: "setup-registration-failed",
        }),
      );
      await nextTurn();
      expect(process.listenerCount(event)).toBe(before + 1);
      expect(cleaned).not.toHaveBeenCalled();
      expect(retained?.resolveConfigApiKey?.({ provider: "repeated-setup", env: {} })).toBe(
        "ready:2",
      );
    } finally {
      await retirePluginCache(cache);
      process.off(cleanupEvent, cleaned);
    }
    expect(process.listenerCount(event)).toBe(before);
    expect(cleaned).toHaveBeenCalledOnce();
  });

  it.each(["success", "cancel", "failure"] as const)(
    "owns setup authentication through %s after releasing the installation lease",
    async (outcome) => {
      await withOpenClawTestState({ label: "setup-auth-owner" }, async (state) => {
        const id = "lease-auth";
        const rootDir = state.path("setup-plugin");
        fs.mkdirSync(rootDir);
        const event = `setup-auth-${outcome}`;
        const before = process.listenerCount(event);
        const cleanup = state.path("setup-cleaned.txt");
        fs.writeFileSync(
          path.join(rootDir, "package.json"),
          JSON.stringify({
            name: "@example/lease-auth",
            version: "1.0.0",
            type: "commonjs",
            openclaw: { extensions: ["./setup-api.cjs"], setupEntry: "./setup-api.cjs" },
          }),
        );
        fs.writeFileSync(
          path.join(rootDir, "openclaw.plugin.json"),
          JSON.stringify({
            id,
            providers: [id],
            configSchema: { type: "object", properties: {} },
            providerAuthChoices: [
              { provider: id, method: "synthetic", choiceId: id, choiceLabel: "Lease auth" },
            ],
            setup: { requiresRuntime: true, providers: [{ id }] },
          }),
        );
        fs.writeFileSync(
          path.join(rootDir, "setup-api.cjs"),
          `
          const listener = () => {};
          process.on(${JSON.stringify(event)}, listener);
          module.exports = { id: "lease-auth", register(api) {
            api.lifecycle.onDispose(() => {
              process.off(${JSON.stringify(event)}, listener);
              require("node:fs").writeFileSync(${JSON.stringify(cleanup)}, "closed");
            });
            api.registerProvider({ id: "lease-auth", label: "Lease auth", auth: [{
              id: "synthetic", label: "Synthetic", kind: "custom",
              run: async (ctx) => {
                await ctx.prompter.note("auth entered", "Fixture");
                ctx.signal?.throwIfAborted();
                ${outcome === "failure" ? 'throw new Error("auth callback failed");' : ""}
                return { profiles: [{ profileId: "lease-auth:synthetic", credential: {
                  type: "api_key", provider: "lease-auth", keyRef: { source: "env", provider: "default", id: "SYNTHETIC_AUTH_KEY" }
                } }] };
              }
            }] });
          } };
        `,
        );
        const started = createDeferredCore();
        const release = createDeferredCore();
        const controller = new AbortController();
        const cancelled = new Error("auth cancelled");
        let entered = false;
        let operationCache: ReturnType<typeof getScopedPluginCache>;
        const work = prepareAuthChoiceLoadedPluginProvider(
          {
            authChoice: id,
            config: {
              plugins: {
                allow: [id],
                load: { paths: [rootDir] },
                entries: { [id]: { enabled: true } },
                slots: { memory: "none" },
              },
            },
            env: state.env,
            agentDir: state.path("agent"),
            workspaceDir: state.path("workspace"),
            setDefaultModel: false,
            isRemote: true,
            signal: controller.signal,
            runtime: createNonExitingRuntime(),
            prompter: createWizardPrompter({
              note: async (message) => {
                if (message === "auth entered") {
                  operationCache = getScopedPluginCache();
                  entered = true;
                  started.resolve();
                  await release.promise;
                }
              },
              confirm: async () => true,
              select: async (params) => {
                const selected =
                  params.options.find((option) => option.value === true) ?? params.options[0];
                if (!selected) {
                  throw new Error("fixture prompt had no choices");
                }
                return selected.value;
              },
            }),
          },
          (prepared) => prepared,
        ).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          await Promise.race([started.promise, work]);
          expect(entered).toBe(true);
          expect(operationCache?.kind).toBe("operation");
          expect(operationCache?.retirement).toBeUndefined();
          expect(process.listenerCount(event)).toBe(before + 1);
          // A second real lease can be acquired while the provider is still waiting for input.
          await withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async (lease) =>
            lease.assertOwned(),
          );
          if (outcome === "cancel") {
            controller.abort(cancelled);
          }
          release.resolve();
          const result = await work;
          expect(process.listenerCount(event)).toBe(before);
          expect(fs.readFileSync(cleanup, "utf8")).toBe("closed");
          expect(operationCache?.retirement).toBeDefined();
          if (outcome === "success") {
            expect(result.ok).toBe(true);
            if (!result.ok || !result.value) {
              throw new Error("auth fixture did not prepare persistence");
            }
            expect(result.value.authProfiles).toHaveLength(1);
            await expect(result.value.persistAuthProfiles()).resolves.toBeUndefined();
          } else {
            expect(result.ok).toBe(false);
            if (result.ok) {
              throw new Error("auth fixture unexpectedly succeeded");
            }
            if (outcome === "cancel") {
              expect(result.error).toBe(cancelled);
            } else {
              expect(String(result.error)).toContain("auth callback failed");
            }
          }
        } finally {
          release.resolve();
          await work;
        }
      });
    },
  );

  it.each([undefined, ["trace-provider"], []])(
    "traces prepared setup lookup with plugin IDs %j",
    (pluginIds) => {
      const rootDir = fs.realpathSync(makeTrackedTempDir("openclaw-setup-trace", tempDirs));
      const setupSource = path.join(rootDir, "setup-api.cjs");
      fs.writeFileSync(
        setupSource,
        'module.exports = { register(api) { api.registerProvider({ id: "trace-provider", label: "Trace provider" }); } };\n',
      );
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "trace-provider",
            rootDir,
            origin: "global",
            setupSource,
            setup: { requiresRuntime: true, providers: [{ id: "trace-provider" }] },
          },
        ],
      });
      vi.stubEnv("OPENCLAW_PLUGIN_LIFECYCLE_TRACE", "1");
      const trace = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const provider = withPluginMetadataSnapshotScope(
        snapshot,
        () => resolvePluginSetupProviderCore({ provider: "trace-provider", pluginIds }),
        { trustConfigIdentity: true },
      );

      expect(provider?.label).toBe(pluginIds?.length === 0 ? undefined : "Trace provider");
      const phases = trace.mock.calls
        .map(([message]) => message)
        .filter((message) => message.includes('phase="manifest registry"'));
      const pluginIdCount = pluginIds ? ` pluginIdCount=${pluginIds.length}` : "";
      expect(phases).toEqual([
        expect.stringMatching(
          new RegExp(
            `^\\[plugins:lifecycle\\] phase="manifest registry" ms=\\d+\\.\\d{2} status=ok includeDisabled=true${pluginIdCount} indexPluginCount=1$`,
          ),
        ),
      ]);
    },
  );

  it.each<{
    artifactDir: string;
    declared: boolean;
    competingDist?: string;
  }>([
    { artifactDir: ".", declared: true },
    { artifactDir: ".", declared: false },
    { artifactDir: "dist", declared: false },
    { artifactDir: ".", declared: false, competingDist: "setup-api.ts" },
    {
      artifactDir: ".",
      declared: false,
      competingDist: "setup-api.js",
    },
  ])(
    "reloads installed $artifactDir setup artifacts (declared: $declared, dist conflict: $competingDist)",
    ({ artifactDir, declared, competingDist }) => {
      const rootDir = fs.realpathSync(makeTrackedTempDir("openclaw-setup-lifecycle", tempDirs));
      const artifactRoot = path.join(rootDir, artifactDir);
      fs.mkdirSync(artifactRoot, { recursive: true });
      const setupSource = path.join(artifactRoot, "setup-api.cjs");
      const dependencyPath = path.join(artifactRoot, "setup-dependency.cjs");
      if (competingDist) {
        fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
        fs.writeFileSync(
          path.join(rootDir, "dist", competingDist),
          'module.exports = { register(api) { api.registerProvider({ id: "setup-lifecycle", label: "wrong-dist-entry" }); } };\n',
          "utf8",
        );
      }
      const writeSetupArtifact = (version: string) => {
        fs.writeFileSync(dependencyPath, `module.exports = "dependency-${version}";\n`, "utf8");
        fs.writeFileSync(
          setupSource,
          `module.exports = { register(api) { api.registerProvider({ id: "setup-lifecycle", label: "entry-${version}:" + require("./setup-dependency.cjs") }); } };\n`,
          "utf8",
        );
      };
      const manifestRegistry = {
        plugins: [
          {
            id: "setup-lifecycle",
            rootDir,
            source: setupSource,
            ...(declared ? { setupSource } : {}),
            manifestPath: path.join(rootDir, "openclaw.plugin.json"),
            origin: "global",
            channels: [],
            providers: ["setup-lifecycle"],
            cliBackends: [],
            skills: [],
            hooks: [],
            setup: { requiresRuntime: true, providers: [{ id: "setup-lifecycle" }] },
          },
        ],
        diagnostics: [],
      } satisfies PluginManifestRegistry;

      writeSetupArtifact("before");
      expect(resolvePluginSetupRegistry({ manifestRegistry }).providers[0]?.provider.label).toBe(
        "entry-before:dependency-before",
      );

      writeSetupArtifact("after");
      clearPluginMetadataLifecycleCaches();

      expect(resolvePluginSetupRegistry({ manifestRegistry }).providers[0]?.provider.label).toBe(
        "entry-after:dependency-after",
      );
    },
  );

  it.each(
    ["dist", "dist-runtime"].flatMap((artifactRootName) =>
      [false, true].map((computed) => ({ artifactRootName, computed })),
    ),
  )(
    "reloads bundled setup artifacts from $artifactRootName (computed: $computed)",
    ({ artifactRootName, computed }) => {
      const packageRoot = fs.realpathSync(
        makeTrackedTempDir("openclaw-bundled-setup-lifecycle", tempDirs),
      );
      const rootDir = path.join(packageRoot, "extensions", "bundled-setup");
      const artifactRoot = path.join(packageRoot, artifactRootName, "extensions", "bundled-setup");
      fs.mkdirSync(rootDir, { recursive: true });
      fs.mkdirSync(artifactRoot, { recursive: true });
      fs.writeFileSync(
        path.join(artifactRoot, "package.json"),
        JSON.stringify({ openclaw: { setupEntry: "./setup-api.js" } }),
      );
      const sourcePath = path.join(rootDir, "setup-api.ts");
      const artifactPath = path.join(artifactRoot, "setup-api.js");
      const dependencyPath =
        artifactRootName === "dist"
          ? path.join(packageRoot, artifactRootName, "setup-dependency.cjs")
          : path.join(artifactRoot, "setup-dependency.cjs");
      const dependencyImport =
        artifactRootName === "dist" ? "../../setup-dependency.cjs" : "./setup-dependency.cjs";
      fs.writeFileSync(sourcePath, "export {};\n", "utf8");
      const writeBundledArtifact = (version: string) => {
        fs.writeFileSync(dependencyPath, `module.exports = "dependency-${version}";\n`, "utf8");
        fs.writeFileSync(
          artifactPath,
          `const load = name => require(name);
           module.exports = { register(api) { api.registerProvider({ id: "bundled-setup", label: "entry-${version}:" + ${computed ? "load" : "require"}(${JSON.stringify(dependencyImport)}) }); } };\n`,
          "utf8",
        );
      };
      const manifestRegistry = {
        plugins: [
          {
            id: "bundled-setup",
            rootDir,
            source: sourcePath,
            setupSource: sourcePath,
            manifestPath: path.join(rootDir, "openclaw.plugin.json"),
            origin: "bundled",
            channels: [],
            providers: ["bundled-setup"],
            cliBackends: [],
            skills: [],
            hooks: [],
            setup: { requiresRuntime: true, providers: [{ id: "bundled-setup" }] },
          },
        ],
        diagnostics: [],
      } satisfies PluginManifestRegistry;

      writeBundledArtifact("before");
      expect(resolvePluginSetupRegistry({ manifestRegistry }).providers[0]?.provider.label).toBe(
        "entry-before:dependency-before",
      );

      writeBundledArtifact("after");
      clearPluginMetadataLifecycleCaches();

      expect(resolvePluginSetupRegistry({ manifestRegistry }).providers[0]?.provider.label).toBe(
        "entry-after:dependency-after",
      );
    },
  );
});

describe("plugin setup module lifecycle", () => {
  const temp = useAutoCleanupTempDirTracker(afterEach);

  function fixture(sourceName = "index.cjs") {
    const rootDir = temp.make("openclaw-setup-owner-");
    const source = path.join(rootDir, sourceName);
    const record: PluginManifestRecord = {
      id: "setup-owner",
      origin: "config",
      rootDir,
      source,
      manifestPath: path.join(rootDir, "openclaw.plugin.json"),
      channels: [],
      providers: [],
      cliBackends: [],
      hooks: [],
      skills: [],
    };
    const cache = createPluginCache();
    return {
      cache,
      record,
      rootDir,
      source,
      loader: () =>
        withPluginCache(cache, () => getPluginSetupModuleLoader(record, source, rootDir)),
    };
  }

  it.each([false, true])(
    "keeps setup lazy imports with their transferred owner (changed: %s)",
    async (changed) => {
      const { cache, record, rootDir, source } = fixture();
      const owner = withPluginCache(cache, retainGatewayPluginMetadata);
      const next = createPluginCache();
      const event = `setup-transfer-${changed}`;
      const listeners = process.listenerCount(event);
      const helper = path.join(rootDir, "lazy.mjs");
      fs.writeFileSync(helper, 'export const value = "captured";');
      fs.writeFileSync(
        source,
        `process.on(${JSON.stringify(event)}, () => {});
        module.exports = async () => (await import("./lazy.mjs")).value;`,
      );
      try {
        const value = owner.runBootstrap(() =>
          getPluginSetupModuleLoader(record, source, rootDir)(source),
        );
        if (typeof value !== "function") {
          throw new Error("Expected the setup lazy-import callback");
        }
        const snapshot = withPluginCache(next, () =>
          createPluginMetadataSnapshotFixture({ plugins: [record] }),
        );
        owner.publish(snapshot, new Set(changed ? [record.id] : []));
        fs.writeFileSync(helper, 'export const value = "edited after capture";');
        await owner.waitForRetirement();
        if (changed) {
          expect(() => value()).toThrow("reloaded or disabled");
          expect(process.listenerCount(event)).toBe(listeners + 1);
        } else {
          await expect(value()).resolves.toBe("captured");
          expect(process.listenerCount(event)).toBe(listeners + 1);
        }
        const current = withPluginCache(next, () =>
          getPluginSetupModuleLoader(record, source, rootDir)(source),
        );
        if (typeof current !== "function") {
          throw new Error("Expected the current setup lazy-import callback");
        }
        await expect(current()).resolves.toBe(changed ? "edited after capture" : "captured");
        const evaluations = changed ? 2 : 1;
        expect(process.listenerCount(event)).toBe(listeners + evaluations);
        await owner.close();
        expect(() => current()).toThrow("reloaded or disabled");
        expect(process.listenerCount(event)).toBe(listeners + evaluations);
      } finally {
        await owner.close().finally(() => {
          process.removeAllListeners(event);
        });
      }
    },
  );

  it("retains shared setup callbacks until the last metadata owner joins their cleanup", async () => {
    const { cache, record, rootDir, source } = fixture();
    const first = withPluginCache(cache, retainGatewayPluginMetadata);
    const second = withPluginCache(cache, retainGatewayPluginMetadata);
    const firstCache = createPluginCache();
    const secondCache = createPluginCache();
    const event = "setup-shared-metadata";
    const listeners = process.listenerCount(event);
    const cleanupEntered = createDeferred();
    const releaseCleanup = createDeferred();
    const cleanup = vi.fn(async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
    });
    fs.writeFileSync(
      source,
      `process.on(${JSON.stringify(event)}, () => {}); module.exports = () => "shared";`,
    );
    let closing: Promise<void> | undefined;
    let joining: Promise<void> | undefined;
    let late: ReturnType<typeof retainGatewayPluginMetadata> | undefined;
    try {
      const value = withPluginCache(firstCache, () =>
        first.runBootstrap(() => getPluginSetupModuleLoader(record, source, rootDir)(source)),
      );
      if (typeof value !== "function") {
        throw new Error("Expected the shared setup callback");
      }
      const instance = getPluginValueInstance(value);
      if (!instance) {
        throw new Error("Expected the setup callback's managed instance");
      }
      instance.lifecycle.onDispose(cleanup);
      first.publish(
        withPluginCache(firstCache, () =>
          createPluginMetadataSnapshotFixture({ plugins: [record] }),
        ),
      );
      second.publish(
        withPluginCache(secondCache, () =>
          createPluginMetadataSnapshotFixture({ plugins: [record] }),
        ),
      );
      await Promise.all([first.waitForRetirement(), second.waitForRetirement()]);
      expect(value()).toBe("shared");
      await first.close();
      expect(value()).toBe("shared");
      expect(process.listenerCount(event)).toBe(listeners + 1);
      expect(cleanup).not.toHaveBeenCalled();
      let settled = false;
      closing = second.close().then(() => {
        settled = true;
      });
      joining = second.close();
      await cleanupEntered.promise;
      expect(() => {
        late = withPluginCache(secondCache, retainGatewayPluginMetadata);
      }).toThrow("Gateway plugin metadata is shutting down");
      expect(settled).toBe(false);
      expect(cleanup).toHaveBeenCalledOnce();
      releaseCleanup.resolve();
      await closing;
      await joining;
      expect(() => value()).toThrow("reloaded or disabled");
      expect(process.listenerCount(event)).toBe(listeners + 1);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      releaseCleanup.resolve();
      await Promise.all([first.close(), second.close(), closing, joining, late?.close()]).finally(
        () => {
          process.removeAllListeners(event);
        },
      );
    }
  });

  it("selects a live metadata owner before awaiting a sibling's cleanup", async () => {
    const { cache, record, rootDir, source, loader } = fixture();
    const secondCache = createPluginCache();
    const first = withPluginCache(cache, retainGatewayPluginMetadata);
    const entered = createDeferred();
    const release = createDeferred();
    let second: ReturnType<typeof retainGatewayPluginMetadata> | undefined;
    let closing: Promise<void> | undefined;
    let newcomer: ReturnType<typeof retainGatewayPluginMetadata> | undefined;
    try {
      second = withPluginCache(secondCache, retainGatewayPluginMetadata);
      fs.writeFileSync(source, 'module.exports = () => "ready";');
      const snapshot = withPluginCache(cache, () =>
        createPluginMetadataSnapshotFixture({ plugins: [record] }),
      );
      const survivingSnapshot = withPluginCache(secondCache, () =>
        createPluginMetadataSnapshotFixture({ plugins: [record] }),
      );
      first.publish(snapshot);
      second.publish(survivingSnapshot);
      // Each already-owned cache receives its initial boot snapshot exactly once.
      selectCurrentPluginMetadataCache(secondCache);
      setGatewayPluginMetadataSnapshot(survivingSnapshot);
      selectCurrentPluginMetadataCache(cache);
      setGatewayPluginMetadataSnapshot(snapshot);
      const value = loader()(source);
      if (typeof value !== "function") {
        throw new Error("Expected the retiring setup callback");
      }
      const instance = getPluginValueInstance(value);
      if (!instance) {
        throw new Error("Expected the retiring setup owner");
      }
      instance.lifecycle.onDispose(async () => {
        entered.resolve();
        await release.promise;
      });
      closing = first.close();
      await entered.promise;
      expect(getProcessPluginCache() === secondCache).toBe(true);
      expect(getGatewayPluginMetadataSnapshot()).toBe(survivingSnapshot);
      expect(() => retainGatewayPluginMetadata()).toThrow(
        "Gateway plugin metadata is shutting down",
      );
      release.resolve();
      await closing;
      newcomer = retainGatewayPluginMetadata();
      newcomer.publish(survivingSnapshot);
      await second.close();
      expect(getGatewayPluginMetadataSnapshot()).toBe(survivingSnapshot);
      const current = withPluginCache(secondCache, () =>
        getPluginSetupModuleLoader(record, source, rootDir)(source),
      );
      if (typeof current !== "function") {
        throw new Error("Expected the surviving setup callback");
      }
      expect(current()).toBe("ready");
      await newcomer.close();
      expect(() => current()).toThrow("reloaded or disabled");
    } finally {
      release.resolve();
      await Promise.all([first.close(), second?.close(), newcomer?.close(), closing]);
    }
  });

  it.each(["ts", "cjs"])(
    "retires failed %s setup evaluation and retries with fresh source",
    async (extension) => {
      const { cache, source, loader } = fixture(`index.${extension}`);
      const event = `setup-failed-${extension}`;
      const listeners = process.listenerCount(event);
      fs.writeFileSync(
        source,
        `process.on(${JSON.stringify(event)}, () => {}); throw new Error("setup failed");`,
      );
      try {
        const failed = loader();
        expect(() => failed(source)).toThrow("setup failed");
        expect(process.listenerCount(event)).toBe(listeners + 1);
        fs.writeFileSync(source, 'module.exports = { value: "recovered" };');
        const fresh = loader();
        expect(fresh(source)).toMatchObject({ value: "recovered" });
        expect(() => failed(source)).toThrow(/reloaded|disabled|retir/);
        expect(loader()(source)).toMatchObject({ value: "recovered" });
        expect(process.listenerCount(event)).toBe(listeners + 1);
      } finally {
        await retirePluginCache(cache).finally(() => {
          process.removeAllListeners(event);
        });
      }
    },
  );

  it("evicts setup instances when binding fails so repaired input can load", async () => {
    const { cache, source, rootDir, loader } = fixture();
    fs.rmdirSync(rootDir);
    try {
      expect(loader).toThrow();
      fs.mkdirSync(rootDir);
      fs.writeFileSync(source, 'module.exports = { value: "repaired" };');
      expect(loader()(source)).toMatchObject({ value: "repaired" });
    } finally {
      await retirePluginCache(cache);
    }
  });

  it.each(["pending", "completed"] as const)(
    "retains %s setup cleanup without replacing the cached loader error",
    async (timing) => {
      const { cache, source, rootDir, loader } = fixture();
      const brokenSource = path.join(rootDir, "broken.cjs");
      const cleanupError = new Error("setup cleanup failed");
      const cleanupEntered = createDeferred();
      const releaseCleanup = createDeferred();
      fs.writeFileSync(
        source,
        "module.exports = Object.assign(() => 'ready', { failure: new Error('setup evaluation failed') });",
      );
      fs.writeFileSync(brokenSource, "throw require('./index.cjs').failure;");
      const setup = loader();
      const value = setup(source);
      if (typeof value !== "function") {
        throw new Error("setup fixture did not export its callable");
      }
      expect(value()).toBe("ready");
      const loadError: unknown = Reflect.get(value, "failure");
      expect(loadError).toBeInstanceOf(Error);
      expect(loadError).toMatchObject({ message: "setup evaluation failed" });
      const owner = getPluginValueInstance(value);
      expect(owner).toBeDefined();
      const cleanup = vi.fn(async () => {
        cleanupEntered.resolve();
        await releaseCleanup.promise;
        throw cleanupError;
      });
      owner!.lifecycle.onDispose(cleanup);
      const failedLoad = vi.fn(() => loader()(brokenSource));
      try {
        expect(failedLoad).toThrow();
        expect(failedLoad.mock.results[0]?.value).toBe(loadError);
        await vi.waitFor(() => expect(owner!.disposing).toBe(true));
        await cleanupEntered.promise;
        if (timing === "completed") {
          releaseCleanup.resolve();
          expect((await owner!.dispose()).errors).toEqual([cleanupError]);
          await nextTurn();
        }
        const settled = vi.fn();
        const retirement = retirePluginCache(cache);
        void retirement.then(settled, settled);
        if (timing === "pending") {
          await nextTurn();
          expect(settled).not.toHaveBeenCalled();
          releaseCleanup.resolve();
        }
        const result = await retirement;
        expect(result.failures).toEqual([
          { pluginId: "setup-owner", hookId: "instance", error: cleanupError },
        ]);
        expect((await owner!.dispose()).errors).toEqual([cleanupError]);
        expect(() => setup(brokenSource)).toThrow(/reloaded|disabled|retir/);
        expect(cleanup).toHaveBeenCalledOnce();
      } finally {
        releaseCleanup.resolve();
        await retirePluginCache(cache).catch(() => {});
      }
    },
  );
});

it.each(["available", "failure"] as const)(
  "owns a runtime provider probe through %s after releasing the installation lease",
  async (outcome) => {
    await withOpenClawTestState({ label: "provider-probe-owner" }, async (state) => {
      const id = "probe-owner";
      const rootDir = state.path("runtime-plugin");
      fs.mkdirSync(rootDir);
      const event = `provider-probe-${outcome}`;
      const enteredEvent = `${event}-entered`;
      const before = process.listenerCount(event);
      const cleanup = state.path("probe-cleaned.txt");
      fs.writeFileSync(
        path.join(rootDir, "package.json"),
        JSON.stringify({
          name: "@example/probe-owner",
          version: "1.0.0",
          type: "commonjs",
          openclaw: { extensions: ["./runtime.cjs"] },
        }),
      );
      fs.writeFileSync(
        path.join(rootDir, "openclaw.plugin.json"),
        JSON.stringify({
          id,
          providers: [id],
          configSchema: { type: "object", properties: {} },
          providerAuthChoices: [
            {
              provider: id,
              method: "synthetic",
              choiceId: id,
              choiceLabel: "Probe owner",
              appGuidedDiscovery: true,
            },
          ],
        }),
      );
      fs.writeFileSync(
        path.join(rootDir, "runtime.cjs"),
        `const listener = () => {};
        process.on(${JSON.stringify(event)}, listener);
        module.exports = { id: "probe-owner", register(api) {
          api.lifecycle.onDispose(() => {
            process.off(${JSON.stringify(event)}, listener);
            require("node:fs").writeFileSync(${JSON.stringify(cleanup)}, "closed");
          });
          api.registerProvider({ id: "probe-owner", label: "Probe owner", auth: [{
            id: "synthetic", label: "Synthetic", kind: "custom", run: async () => ({ profiles: [] }),
            appGuidedSetup: { detectAvailability: async () => {
              await new Promise(resolve => process.emit(${JSON.stringify(enteredEvent)}, resolve));
              ${outcome === "failure" ? 'throw new Error("provider unavailable");' : "return true;"}
            } }
          }] });
        } };`,
      );
      const started = createDeferredCore();
      const release = createDeferredCore();
      let entered = false;
      let operationCache: ReturnType<typeof getScopedPluginCache>;
      const observeProbe = (finish: () => void) => {
        operationCache = getScopedPluginCache();
        entered = true;
        started.resolve();
        void release.promise.then(finish);
      };
      process.on(enteredEvent, observeProbe);
      const work = detectAvailableSetupProviderIds({
        config: {
          plugins: {
            allow: [id],
            load: { paths: [rootDir] },
            entries: { [id]: { enabled: true } },
            slots: { memory: "none" },
          },
        },
        env: state.env,
        workspaceDir: state.path("workspace"),
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await Promise.race([started.promise, work]);
        expect(entered).toBe(true);
        expect(operationCache?.kind).toBe("operation");
        expect(operationCache?.retirement).toBeUndefined();
        expect(process.listenerCount(event)).toBe(before + 1);
        await withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async (lease) =>
          lease.assertOwned(),
        );
        release.resolve();
        const result = await work;
        expect(result).toEqual({ ok: true, value: new Set(outcome === "available" ? [id] : []) });
        expect(process.listenerCount(event)).toBe(before);
        expect(fs.readFileSync(cleanup, "utf8")).toBe("closed");
        expect(operationCache?.retirement).toBeDefined();
      } finally {
        release.resolve();
        await work;
        process.off(enteredEvent, observeProbe);
      }
    });
  },
);
