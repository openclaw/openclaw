// Split from include-write-through.publish.test.ts (line-cap ratchet, base
// bc2fb1a63a67ee06c6c6b8a05af61ed9a2ed7cab): post-publish restoration-authority
// and forced-compensation cases. Fixture scaffold (mocks, suite temp roots,
// itWithHome/createFastConfigIO) duplicated from that file -- it is local,
// unexported test infra, not a shared module.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as tmpDirOwner from "../infra/tmp-openclaw-dir.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  publishStagedIncludeWrites,
  restoreStagedIncludeWrites,
  type IncludeWriteRestorer,
} from "./include-write-through.js";
import { hashConfigIncludeRaw } from "./includes.js";
import {
  createConfigIO as createObservedConfigIO,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshotRefreshHandler,
  writeConfigFile,
} from "./io.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { withConfigWriteLock } from "./write-lock.js";

const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn((): PluginManifestRegistry => ({
    diagnostics: [],
    plugins: [],
  })),
);
const mockPrepareConfigFileWrite = vi.hoisted(() =>
  vi.fn<typeof import("./backup-rotation.js").prepareConfigFileWrite>(),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: mockLoadPluginManifestRegistry,
}));

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry: mockLoadPluginManifestRegistry,
  };
});

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorLegacyConfigRules: () => [],
    applyPluginDoctorCompatibilityMigrations: () => ({ next: null, changes: [] }),
  };
});

vi.mock("./backup-rotation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backup-rotation.js")>();
  mockPrepareConfigFileWrite.mockImplementation(actual.prepareConfigFileWrite);
  return {
    ...actual,
    prepareConfigFileWrite: mockPrepareConfigFileWrite,
  };
});

type ConfigIoOptions = Parameters<typeof createObservedConfigIO>[0];

function createConfigIO(options: ConfigIoOptions = {}) {
  const env = options.env ?? ({} as NodeJS.ProcessEnv);
  if (!("NODE_ENV" in env)) {
    // Route real SQLite state through Vitest's worker DB without adding a key to config env snapshots.
    Object.defineProperty(env, "NODE_ENV", { configurable: true, value: "test" });
  }
  return createObservedConfigIO({
    observe: false,
    ...options,
    env,
  });
}

describe("config io write / include write-through restore authority", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-io-restore-" });
  const silentLogger = {
    warn: () => {},
    error: () => {},
  };
  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await suiteRootTracker.make("case");
    return withEnvAsync(
      {
        OPENCLAW_DEFER_SHELL_ENV_FALLBACK: undefined,
        OPENCLAW_LOAD_SHELL_ENV: undefined,
        OPENCLAW_SHELL_ENV_TIMEOUT_MS: undefined,
      },
      () => fn(home),
    );
  }

  beforeAll(async () => {
    await suiteRootTracker.setup();
    vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(
      await suiteRootTracker.make("coordinator"),
    );

    // Default: return an empty plugin list so existing tests that don't need
    // plugin-owned channel schemas keep working unchanged.
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetConfigRuntimeState();
    mockPrepareConfigFileWrite.mockReset();
    const actual =
      await vi.importActual<typeof import("./backup-rotation.js")>("./backup-rotation.js");
    mockPrepareConfigFileWrite.mockImplementation(actual.prepareConfigFileWrite);
  });

  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    vi.mocked(tmpDirOwner.resolvePreferredOpenClawTmpDir).mockRestore();
    await suiteRootTracker.cleanup();
  });
  const configPathForHome = (home: string, fileName = "openclaw.json") =>
    path.join(home, ".openclaw", fileName);

  const formatConfig = (config: unknown) => `${JSON.stringify(config, null, 2)}\n`;
  const writeConfigJson = async (configPath: string, config: unknown) => {
    await fs.writeFile(configPath, formatConfig(config), "utf-8");
  };
  const createHomeConfigIO = (home: string, options: ConfigIoOptions = {}) =>
    createConfigIO({ homedir: () => home, logger: silentLogger, ...options });

  const itWithHome = (name: string, testCase: (home: string) => Promise<void>) => {
    it(name, () => withSuiteHome(testCase));
  };

  const createFastConfigIO = (home: string, options: ConfigIoOptions = {}) =>
    createHomeConfigIO(home, {
      env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      ...options,
    });

  itWithHome(
    "restores an include when post-commit finalization fails inside a guarded mutation flow",
    async (home) => {
      const configPath = configPathForHome(home);
      const tonyPath = path.join(home, ".openclaw", "tony.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(tonyPath, { workspace: "/w/tony" });
      await writeConfigJson(configPath, {
        agents: { ownership: "explicit", entries: { tony: { $include: "./tony.json5" } } },
      });
      const originalRootRaw = await fs.readFile(configPath, "utf-8");
      const originalTonyRaw = await fs.readFile(tonyPath, "utf-8");

      try {
        await withEnvAsync(
          { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" },
          async () => {
            setRuntimeConfigSnapshotRefreshHandler({
              refresh: () => {
                throw new Error("synthetic refresh failure");
              },
            });
            // An ambient guarded owner (a mutation flow) holds the root's write
            // lock with a live source guard while the write runs: the child
            // include lock (io.write.ts's sourceGuard) is captured from that
            // guarded scope. It must not be the authority post-commit rollback
            // uses once runtime finalization later fails -- that inner scope
            // is already closed by then.
            await withConfigWriteLock(
              configPath,
              async () => {
                await expect(
                  writeConfigFile({
                    agents: {
                      ownership: "explicit",
                      entries: { tony: { workspace: "/w/tony-next" } },
                    },
                  } as unknown as OpenClawConfig),
                ).rejects.toThrow(/runtime snapshot refresh failed: synthetic refresh failure/);
              },
              process.env,
              () => {},
            );
          },
        );
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
      await expect(fs.readFile(tonyPath, "utf-8")).resolves.toBe(originalTonyRaw);
    },
  );

  itWithHome(
    "restores previous include bytes when the copy fallback recreates the target before a later throw",
    async (home) => {
      const configPath = configPathForHome(home);
      const tonyPath = path.join(home, ".openclaw", "tony.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(tonyPath, { workspace: "/w/tony" });
      await writeConfigJson(configPath, {
        agents: { ownership: "explicit", entries: { tony: { $include: "./tony.json5" } } },
      });
      const originalTonyRaw = await fs.readFile(tonyPath, "utf-8");
      const io = createFastConfigIO(home);

      // Simulates fs-safe's permission-error copy fallback: it removes the
      // existing target (firing onRootRemoved), then recreates it -- here
      // with garbage bytes -- before the write itself throws.
      mockPrepareConfigFileWrite.mockImplementationOnce(
        async (params: { configPath: string; fsModule: typeof import("node:fs") }) => ({
          publish: () => {
            params.fsModule.rmSync(params.configPath, { force: true });
            params.fsModule.writeFileSync(params.configPath, "{not the previous content}", "utf-8");
            throw new Error("synthetic copy-fallback write failure after recreate");
          },
          [Symbol.asyncDispose]: async () => {},
        }),
      );

      await expect(
        io.writeConfigFile({
          agents: {
            ownership: "explicit",
            entries: { tony: { workspace: "/w/tony-next" } },
          },
        } as unknown as OpenClawConfig),
      ).rejects.toThrow("synthetic copy-fallback write failure after recreate");

      // The restorer is fenced on the failure's own damage (captured while the
      // per-target lock was still held), not entry.bytes or an unconditional
      // force: since nothing touched the file afterward, current bytes still
      // match that captured damage, so restoration proceeds normally.
      await expect(fs.readFile(tonyPath, "utf-8")).resolves.toBe(originalTonyRaw);
    },
  );

  itWithHome(
    "leaves a concurrent writer's newer content in place when it lands before restoration runs",
    async (home) => {
      const configPath = configPathForHome(home);
      const tonyPath = path.join(home, ".openclaw", "tony.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(tonyPath, { workspace: "/w/tony" });
      const originalTonyRaw = await fs.readFile(tonyPath, "utf-8");
      const previousHash = hashConfigIncludeRaw(originalTonyRaw);

      // Simulates fs-safe's permission-error copy fallback: it removes the
      // existing target (firing onRootRemoved), then recreates it -- here
      // with garbage bytes -- before the write itself throws.
      mockPrepareConfigFileWrite.mockImplementationOnce(
        async (params: { configPath: string; fsModule: typeof import("node:fs") }) => ({
          publish: () => {
            params.fsModule.rmSync(params.configPath, { force: true });
            params.fsModule.writeFileSync(params.configPath, "{not the previous content}", "utf-8");
            throw new Error("synthetic copy-fallback write failure after recreate");
          },
          [Symbol.asyncDispose]: async () => {},
        }),
      );

      const restorers: IncludeWriteRestorer[] = [];
      await expect(
        publishStagedIncludeWrites({
          staged: [
            {
              includePath: ["agents", "entries", "tony"],
              targetPath: tonyPath,
              canonicalTargetPath: tonyPath,
              includeGraphKey: path.normalize(tonyPath),
              bytes: '{\n  "workspace": "/w/tony-next"\n}\n',
              previousRaw: originalTonyRaw,
              previousHash,
            },
          ],
          restorers,
          configPath,
        }),
      ).rejects.toThrow("synthetic copy-fallback write failure after recreate");
      expect(restorers).toHaveLength(1);

      // A writer saves newer content in the exact gap the fix must fence:
      // after the failed publish's own per-target lock released, before
      // restoration (below) re-acquires it.
      const concurrentWriterRaw = '{\n  "workspace": "/w/concurrent-writer"\n}\n';
      await fs.writeFile(tonyPath, concurrentWriterRaw, "utf-8");

      await restoreStagedIncludeWrites(restorers, { configPath });

      // The restorer's fence was captured against the failed publish's own
      // damage, not the concurrent writer's save: current bytes no longer
      // match that captured damage, so restoration must miss and the newer
      // save must survive untouched.
      await expect(fs.readFile(tonyPath, "utf-8")).resolves.toBe(concurrentWriterRaw);
    },
  );
});
