// Fixture scaffold (mocks, suite temp roots, itWithHome/createFastConfigIO)
// duplicated from include-write-through.publish.test.ts -- it is local,
// unexported test infra, not a shared module.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
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
  stageIncludeWriteThrough,
  type IncludeWriteRestorer,
} from "./include-write-through.js";
import { readConfigFileSnapshot, resetConfigRuntimeState, writeConfigFile } from "./io.js";
import { getConfigSnapshotIncludeLoadGraph } from "./io.snapshot-shared.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const mockLoadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn((): PluginManifestRegistry => ({
    diagnostics: [],
    plugins: [],
  })),
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

// The snapshot-to-stage fence must hold for every writer that starts from a
// snapshot, including the runtime entry and bare baseSnapshot callers that
// supply no include hashes of their own.
describe("config io write / include write-through runtime fence", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-fence-" });

  beforeAll(async () => {
    await suiteRootTracker.setup();
    vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(
      await suiteRootTracker.make("coordinator"),
    );
    mockLoadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [],
    } satisfies PluginManifestRegistry);
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetConfigRuntimeState();
  });

  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    vi.mocked(tmpDirOwner.resolvePreferredOpenClawTmpDir).mockRestore();
    await suiteRootTracker.cleanup();
  });

  const formatConfig = (config: unknown) => `${JSON.stringify(config, null, 2)}\n`;
  const writeConfigJson = async (configPath: string, config: unknown) => {
    await fs.writeFile(configPath, formatConfig(config), "utf-8");
  };

  async function makeCase(): Promise<{ home: string; configPath: string; workPath: string }> {
    const home = await suiteRootTracker.make("case");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const workPath = path.join(home, ".openclaw", "config", "agents", "work.json5");
    await fs.mkdir(path.dirname(workPath), { recursive: true });
    await writeConfigJson(workPath, {
      name: "Work",
      model: "gpt-4",
    });
    await writeConfigJson(configPath, {
      agents: {
        ownership: "explicit",
        entries: { work: { $include: "./config/agents/work.json5" } },
      },
    });
    return { home, configPath, workPath };
  }

  async function makeSymlinkedRootCase() {
    const home = await suiteRootTracker.make("symlink-case");
    const realRoot = path.join(home, "real-config");
    const linkRoot = path.join(home, "linked-config");
    const realConfigPath = path.join(realRoot, "openclaw.json");
    const realWorkPath = path.join(realRoot, "config", "agents", "work.json5");
    await fs.mkdir(path.dirname(realWorkPath), { recursive: true });
    await writeConfigJson(realWorkPath, { name: "Work", model: "gpt-4" });
    await writeConfigJson(realConfigPath, {
      wizard: { lastRunCommand: "install" },
      agents: {
        ownership: "explicit",
        entries: { work: { $include: "./config/agents/work.json5" } },
      },
    });
    await fs.symlink(realRoot, linkRoot, process.platform === "win32" ? "junction" : undefined);
    return {
      configPath: path.join(linkRoot, "openclaw.json"),
      realConfigPath,
      realWorkPath,
    };
  }

  it("rejects a runtime writeConfigFile save when an included agent file changed after the snapshot read", async () => {
    const { configPath, workPath } = await makeCase();
    const originalRootRaw = await fs.readFile(configPath, "utf-8");

    // The runtime writer asserts the config path twice before its snapshot
    // read and once right after it, ahead of staging. Editing on that third
    // call only lands one concurrent write inside the snapshot-to-stage
    // window; a later edit would trip the separate stage-to-publish fence.
    let calls = 0;
    const concurrentRaw = formatConfig({ name: "Work", model: "concurrent-edit" });
    const assertConfigPathForWrite = () => {
      calls += 1;
      if (calls === 3) {
        fsSync.writeFileSync(workPath, concurrentRaw, "utf-8");
      }
    };

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" }, async () => {
      await expect(
        writeConfigFile(
          {
            agents: {
              ownership: "explicit",
              entries: { work: { model: "gpt-4-turbo" } },
            },
          } as unknown as OpenClawConfig,
          { assertConfigPathForWrite },
        ),
      ).rejects.toThrow("included config changed since last load");
    });

    expect(calls).toBeGreaterThanOrEqual(3);
    await expect(fs.readFile(workPath, "utf-8")).resolves.toBe(concurrentRaw);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
  });

  it("fences a bare baseSnapshot from readConfigFileSnapshot", async () => {
    const { configPath, workPath } = await makeCase();
    const originalRootRaw = await fs.readFile(configPath, "utf-8");

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" }, async () => {
      // The wizard/install shape: a bare ConfigFileSnapshot from the public
      // reader, threaded straight into writeConfigFile as baseSnapshot with
      // no includeFileHashesForWrite/Targets of its own.
      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      const externalRaw = formatConfig({
        name: "Work",
        model: "concurrent-external-edit",
      });
      await fs.writeFile(workPath, externalRaw, "utf-8");

      await expect(
        writeConfigFile(
          {
            agents: {
              ownership: "explicit",
              entries: { work: { model: "gpt-4-turbo" } },
            },
          } as unknown as OpenClawConfig,
          { baseSnapshot: snapshot },
        ),
      ).rejects.toThrow("included config changed since last load");

      await expect(fs.readFile(workPath, "utf-8")).resolves.toBe(externalRaw);
    });

    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
  });

  it("refuses to stage include writes for a snapshot with no load-time fence", async () => {
    const { configPath, workPath } = await makeCase();
    const originalRootRaw = await fs.readFile(configPath, "utf-8");
    const originalWorkRaw = await fs.readFile(workPath, "utf-8");

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" }, async () => {
      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      // No read recorded load hashes for this object, so the write fails
      // closed even though nothing on disk changed.
      const clonedSnapshot = { ...snapshot };

      await expect(
        writeConfigFile(
          {
            agents: {
              ownership: "explicit",
              entries: { work: { model: "gpt-4-turbo" } },
            },
          } as unknown as OpenClawConfig,
          { baseSnapshot: clonedSnapshot },
        ),
      ).rejects.toThrow(ConfigMutationConflictError);
    });

    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
    await expect(fs.readFile(workPath, "utf-8")).resolves.toBe(originalWorkRaw);
  });

  // Root -> config/models.json5 (intermediate) -> config/old.json5 (leaf). The
  // intermediate is itself a load-graph key: redirecting its pointer to
  // new.json5 must conflict even though the staged leaf old.json5 is untouched.
  const ollamaCatalog = (models: unknown) => ({
    providers: { ollama: { baseUrl: "http://127.0.0.1:11434", api: "ollama", models } },
  });
  const llama3Models = [{ id: "llama3", name: "llama3" }];
  const qwenModels = [{ id: "qwen3", name: "qwen3" }];
  const mixedSave = {
    wizard: { lastRunCommand: "update" },
    agents: { ownership: "explicit", entries: { work: { workspace: "/w/work" } } },
    models: ollamaCatalog(qwenModels),
  } as unknown as OpenClawConfig;
  // Same root delta as mixedSave, but models resolves to the catalog the
  // snapshot already read -- nothing stages, so only the root's own write
  // exercises the guard.
  const rootOnlySave = {
    wizard: { lastRunCommand: "update" },
    agents: { ownership: "explicit", entries: { work: { workspace: "/w/work" } } },
    models: ollamaCatalog(llama3Models),
  } as unknown as OpenClawConfig;

  async function makeIncludeGraphCase() {
    const home = await suiteRootTracker.make("case");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const modelsPath = path.join(home, ".openclaw", "config", "models.json5");
    const oldPath = path.join(home, ".openclaw", "config", "old.json5");
    const newPath = path.join(home, ".openclaw", "config", "new.json5");
    const redirectedModelsRaw = formatConfig(ollamaCatalog({ $include: "./new.json5" }));
    await fs.mkdir(path.dirname(modelsPath), { recursive: true });
    await writeConfigJson(oldPath, llama3Models);
    await writeConfigJson(newPath, qwenModels);
    await writeConfigJson(modelsPath, ollamaCatalog({ $include: "./old.json5" }));
    await writeConfigJson(configPath, {
      wizard: { lastRunCommand: "install" },
      agents: { ownership: "explicit", entries: { work: { workspace: "/w/work" } } },
      models: { $include: "./config/models.json5" },
    });
    const untouched = [configPath, oldPath, newPath];
    const originals = await Promise.all(untouched.map((file) => fs.readFile(file, "utf-8")));
    const originalModelsRaw = await fs.readFile(modelsPath, "utf-8");
    return {
      configPath,
      modelsPath,
      oldPath,
      redirectIntermediate: () => fsSync.writeFileSync(modelsPath, redirectedModelsRaw, "utf-8"),
      redirectedModelsRaw,
      // A detached write shows up as old.json5 rewritten beside a saved root.
      expectNothingWritten: async () => {
        const current = await Promise.all(untouched.map((file) => fs.readFile(file, "utf-8")));
        expect(current).toEqual(originals);
      },
      expectOnlyOldLeafChanged: async (expectedOldRaw: string) => {
        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originals[0]);
        await expect(fs.readFile(modelsPath, "utf-8")).resolves.toBe(originalModelsRaw);
        await expect(fs.readFile(oldPath, "utf-8")).resolves.toBe(expectedOldRaw);
        await expect(fs.readFile(newPath, "utf-8")).resolves.toBe(originals[2]);
      },
    };
  }

  it("rejects a mixed save when an intermediate include is redirected after the snapshot read", async () => {
    const graphCase = await makeIncludeGraphCase();
    // Same window as the first test: the third path assertion follows the
    // snapshot read and precedes staging.
    let calls = 0;
    const assertConfigPathForWrite = () => {
      calls += 1;
      if (calls === 3) {
        graphCase.redirectIntermediate();
      }
    };

    await withEnvAsync(
      { OPENCLAW_CONFIG_PATH: graphCase.configPath, OPENCLAW_TEST_FAST: "1" },
      async () => {
        await expect(writeConfigFile(mixedSave, { assertConfigPathForWrite })).rejects.toThrow(
          ConfigMutationConflictError,
        );
      },
    );

    expect(calls).toBeGreaterThanOrEqual(3);
    await graphCase.expectNothingWritten();
  });

  it("rejects leaf publication when an intermediate include is redirected after staging", async () => {
    const graphCase = await makeIncludeGraphCase();

    await withEnvAsync(
      { OPENCLAW_CONFIG_PATH: graphCase.configPath, OPENCLAW_TEST_FAST: "1" },
      async () => {
        const snapshot = await readConfigFileSnapshot();
        // includeLoadGraph is required now; this read always binds one via
        // the WeakMap, so this narrows the type instead of asserting past a gap.
        const loadGraph = expectDefined(
          getConfigSnapshotIncludeLoadGraph(snapshot),
          "config snapshot load graph",
        );
        const { staged } = await stageIncludeWriteThrough({
          snapshot,
          pendingIncludeWrites: [
            { includePath: ["models", "providers", "ollama", "models"], value: qwenModels },
          ],
          envForRestore: process.env,
          homedir: os.homedir(),
          includeLoadGraph: loadGraph,
        });
        expect(staged).toHaveLength(1);

        graphCase.redirectIntermediate();
        const restorers: IncludeWriteRestorer[] = [];
        await expect(
          publishStagedIncludeWrites({
            staged,
            restorers,
            configPath: graphCase.configPath,
            includeGraph: loadGraph,
            rootRawForGraph: snapshot.raw,
          }),
        ).rejects.toThrow(ConfigMutationConflictError);
        expect(restorers).toHaveLength(0);
      },
    );

    await graphCase.expectNothingWritten();
  });

  it("restores a published leaf when an intermediate include redirects before root publish", async () => {
    const graphCase = await makeIncludeGraphCase();

    await withEnvAsync(
      { OPENCLAW_CONFIG_PATH: graphCase.configPath, OPENCLAW_TEST_FAST: "1" },
      async () => {
        const snapshot = await readConfigFileSnapshot();
        await expect(
          writeConfigFile(mixedSave, {
            baseSnapshot: snapshot,
            beforeCommit: async () => {
              graphCase.redirectIntermediate();
            },
          }),
        ).rejects.toThrow(ConfigMutationConflictError);
      },
    );

    // The external redirect survives; the root and detached leaf do not.
    await graphCase.expectNothingWritten();
    await expect(fs.readFile(graphCase.modelsPath, "utf-8")).resolves.toBe(
      graphCase.redirectedModelsRaw,
    );
  });

  it("rejects a leaf edit after the graph check but before staging reads it", async () => {
    const graphCase = await makeIncludeGraphCase();
    const concurrentLeafRaw = formatConfig([{ id: "external", name: "external" }]);

    await withEnvAsync(
      { OPENCLAW_CONFIG_PATH: graphCase.configPath, OPENCLAW_TEST_FAST: "1" },
      async () => {
        const snapshot = await readConfigFileSnapshot();
        const loadGraph = expectDefined(
          getConfigSnapshotIncludeLoadGraph(snapshot),
          "config snapshot load graph",
        );
        const realpath = fs.realpath;
        const realpathSpy = vi.spyOn(fs, "realpath").mockImplementationOnce(async (target) => {
          await fs.writeFile(graphCase.oldPath, concurrentLeafRaw, "utf-8");
          return await realpath(target);
        });
        try {
          await expect(
            stageIncludeWriteThrough({
              snapshot,
              pendingIncludeWrites: [
                { includePath: ["models", "providers", "ollama", "models"], value: qwenModels },
              ],
              envForRestore: process.env,
              homedir: os.homedir(),
              includeLoadGraph: loadGraph,
            }),
          ).rejects.toThrow(ConfigMutationConflictError);
        } finally {
          realpathSpy.mockRestore();
        }
      },
    );

    await graphCase.expectOnlyOldLeafChanged(concurrentLeafRaw);
  });

  it("fences the include graph for a baseSnapshot writer from readConfigFileSnapshot", async () => {
    const graphCase = await makeIncludeGraphCase();

    await withEnvAsync(
      { OPENCLAW_CONFIG_PATH: graphCase.configPath, OPENCLAW_TEST_FAST: "1" },
      async () => {
        // A bare baseSnapshot carries no maps: hashes and targets both come
        // from the graph its read bound to the snapshot object.
        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        graphCase.redirectIntermediate();

        await expect(writeConfigFile(mixedSave, { baseSnapshot: snapshot })).rejects.toThrow(
          ConfigMutationConflictError,
        );
      },
    );

    await graphCase.expectNothingWritten();
  });

  it("rejects a root-only save when an include file changed after the snapshot read", async () => {
    const graphCase = await makeIncludeGraphCase();

    await withEnvAsync(
      { OPENCLAW_CONFIG_PATH: graphCase.configPath, OPENCLAW_TEST_FAST: "1" },
      async () => {
        // wizard.lastRunCommand is the only key that actually changes; the
        // root publication guard must still fence on the load-time graph.
        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        graphCase.redirectIntermediate();

        await expect(writeConfigFile(rootOnlySave, { baseSnapshot: snapshot })).rejects.toThrow(
          ConfigMutationConflictError,
        );
      },
    );

    await graphCase.expectNothingWritten();
  });

  it("rejects a root-only save from a cloned baseSnapshot that lost its load graph", async () => {
    const graphCase = await makeIncludeGraphCase();

    await withEnvAsync(
      { OPENCLAW_CONFIG_PATH: graphCase.configPath, OPENCLAW_TEST_FAST: "1" },
      async () => {
        // A spread copy carries the same fields but is a new object, so the
        // WeakMap-bound load graph never resolves for it.
        const snapshot = { ...(await readConfigFileSnapshot()) };
        graphCase.redirectIntermediate();

        await expect(writeConfigFile(rootOnlySave, { baseSnapshot: snapshot })).rejects.toThrow(
          ConfigMutationConflictError,
        );
      },
    );

    await graphCase.expectNothingWritten();
  });

  it("still publishes a mixed root+include write through the runtime entry when nothing raced it", async () => {
    const { configPath, workPath } = await makeCase();

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" }, async () => {
      await writeConfigFile({
        agents: {
          ownership: "explicit",
          entries: { work: { name: "Work", model: "gpt-4-turbo" } },
        },
      } as unknown as OpenClawConfig);
    });

    const rootAfter = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    expect(rootAfter.agents).toEqual({
      ownership: "explicit",
      entries: { work: { $include: "./config/agents/work.json5" } },
    });
    const workAfter = JSON.parse(await fs.readFile(workPath, "utf-8")) as Record<string, unknown>;
    expect(workAfter.model).toBe("gpt-4-turbo");
    expect(workAfter.name).toBe("Work");
  });

  it("publishes through a symlinked config root without conflating lexical and canonical paths", async () => {
    const { configPath, realConfigPath, realWorkPath } = await makeSymlinkedRootCase();

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" }, async () => {
      const snapshot = await readConfigFileSnapshot();
      const loadGraph = expectDefined(
        getConfigSnapshotIncludeLoadGraph(snapshot),
        "config snapshot load graph",
      );
      const { staged } = await stageIncludeWriteThrough({
        snapshot,
        pendingIncludeWrites: [
          {
            includePath: ["agents", "entries", "work"],
            value: { name: "Work", model: "gpt-4-turbo" },
          },
        ],
        envForRestore: process.env,
        homedir: os.homedir(),
        includeLoadGraph: loadGraph,
      });
      await publishStagedIncludeWrites({
        staged,
        restorers: [],
        configPath,
        includeGraph: loadGraph,
        rootRawForGraph: snapshot.raw,
      });
    });

    const rootAfter = JSON.parse(await fs.readFile(realConfigPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(rootAfter.agents).toEqual({
      ownership: "explicit",
      entries: { work: { $include: "./config/agents/work.json5" } },
    });
    const workAfter = JSON.parse(await fs.readFile(realWorkPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(workAfter.model).toBe("gpt-4-turbo");
  });

  it("restores a published include through a symlinked config root during compensation", async () => {
    const { configPath, realConfigPath, realWorkPath } = await makeSymlinkedRootCase();
    const originalRootRaw = await fs.readFile(realConfigPath, "utf-8");
    const originalWorkRaw = await fs.readFile(realWorkPath, "utf-8");

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" }, async () => {
      const snapshot = await readConfigFileSnapshot();
      const loadGraph = expectDefined(
        getConfigSnapshotIncludeLoadGraph(snapshot),
        "config snapshot load graph",
      );
      const { staged } = await stageIncludeWriteThrough({
        snapshot,
        pendingIncludeWrites: [
          {
            includePath: ["agents", "entries", "work"],
            value: { name: "Work", model: "gpt-4-turbo" },
          },
        ],
        envForRestore: process.env,
        homedir: os.homedir(),
        includeLoadGraph: loadGraph,
      });
      const restorers: IncludeWriteRestorer[] = [];
      await publishStagedIncludeWrites({
        staged,
        restorers,
        configPath,
        includeGraph: loadGraph,
        rootRawForGraph: snapshot.raw,
      });
      expect(restorers).toHaveLength(1);
      await restoreStagedIncludeWrites(restorers, { configPath });
    });

    await expect(fs.readFile(realConfigPath, "utf-8")).resolves.toBe(originalRootRaw);
    await expect(fs.readFile(realWorkPath, "utf-8")).resolves.toBe(originalWorkRaw);
  });

  it("recovers an invalid interrupted mixed write from the published include backup", async () => {
    const home = await suiteRootTracker.make("interrupted-recovery");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const includedPath = path.join(home, ".openclaw", "config", "agents", "included.json5");
    await fs.mkdir(path.dirname(includedPath), { recursive: true });
    const includedDir = path.join(home, "agents", "included");
    const rootDir = path.join(home, "agents", "root");
    const originalIncludedRaw = formatConfig({ name: "Included", agentDir: includedDir });
    await fs.writeFile(includedPath, originalIncludedRaw, "utf-8");
    await writeConfigJson(configPath, {
      agents: {
        ownership: "explicit",
        entries: {
          included: { $include: "./config/agents/included.json5" },
          root: { name: "Root", agentDir: rootDir },
        },
      },
    });

    await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" }, async () => {
      const snapshot = await readConfigFileSnapshot();
      const loadGraph = expectDefined(
        getConfigSnapshotIncludeLoadGraph(snapshot),
        "config snapshot load graph",
      );
      const { staged } = await stageIncludeWriteThrough({
        snapshot,
        pendingIncludeWrites: [
          {
            includePath: ["agents", "entries", "included"],
            value: { name: "Included", agentDir: rootDir },
          },
        ],
        envForRestore: process.env,
        homedir: os.homedir(),
        includeLoadGraph: loadGraph,
      });
      await publishStagedIncludeWrites({
        staged,
        restorers: [],
        configPath,
        includeGraph: loadGraph,
        rootRawForGraph: snapshot.raw,
      });

      expect((await readConfigFileSnapshot()).valid).toBe(false);
      await expect(fs.readFile(`${includedPath}.bak`, "utf-8")).resolves.toBe(originalIncludedRaw);
      await fs.copyFile(`${includedPath}.bak`, includedPath);
      expect((await readConfigFileSnapshot()).valid).toBe(true);

      await writeConfigFile({
        agents: {
          ownership: "explicit",
          entries: {
            included: { name: "Included", agentDir: rootDir },
            root: { name: "Root", agentDir: includedDir },
          },
        },
      } as unknown as OpenClawConfig);
      expect((await readConfigFileSnapshot()).valid).toBe(true);
    });
  });
});
