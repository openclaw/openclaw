// Relocated from io.write-config.test.ts (base b45488b243b03defb97422338166d9d1b3ba6b6c):
// real-fs mixed root+include-owned write-through publish/repair cases.
// Fixture scaffold (mocks, suite temp roots, itWithHome/createFastConfigIO)
// duplicated from io.write-config.test.ts's describe("config io write", ...)
// block -- it is local, unexported test infra, not a shared module.
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
import { hashConfigIncludeRaw } from "./includes.js";
import {
  createConfigIO as createObservedConfigIO,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshotRefreshHandler,
  writeConfigFile,
} from "./io.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { withConfigWriteLock } from "./write-lock.js";

// Mock the plugin manifest registry so we can register a fake channel whose
// AJV JSON Schema carries a `default` value.  This lets the #56772 regression
// test exercise the exact code path that caused the bug: AJV injecting
// defaults during the write-back validation pass.
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

describe("config io write / include write-through publish", () => {
  const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-config-io-" });
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
    "repairs invalid include-owned config inside the owning include file",
    async (home) => {
      const configPath = configPathForHome(home);
      const scribePath = path.join(home, ".openclaw", "scribe.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      // `identity` belongs at the agent-entry root; authored under `tools` it is
      // exactly the shape doctor repairs, and it lives only in the include file.
      await writeConfigJson(scribePath, {
        default: true,
        name: "Scribe",
        tools: { profile: "full", identity: { name: "Scribe" } },
      });
      await writeConfigJson(configPath, {
        agents: { entries: { scribe: { $include: "./scribe.json5" } } },
      });
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);

      await io.writeConfigFile({
        agents: {
          entries: {
            scribe: {
              default: true,
              name: "Scribe",
              tools: { profile: "full" },
              identity: { name: "Scribe" },
            },
          },
        },
      } as unknown as OpenClawConfig);

      // The root keeps its directive; the repair lands in the file that owns it.
      const rootAfter = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
      expect(rootAfter.agents).toEqual({ entries: { scribe: { $include: "./scribe.json5" } } });
      const repaired = JSON.parse(await fs.readFile(scribePath, "utf-8")) as Record<
        string,
        unknown
      >;
      expect(repaired.identity).toEqual({ name: "Scribe" });
      expect(repaired.tools).toEqual({ profile: "full" });
    },
  );

  itWithHome(
    "writes valid keyed agent-entry includes through instead of flattening the roster",
    async (home) => {
      const configPath = configPathForHome(home);
      const tonyPath = path.join(home, ".openclaw", "tony.json5");
      const wesPath = path.join(home, ".openclaw", "wes.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(tonyPath, { workspace: "/w/tony" });
      await writeConfigJson(wesPath, { workspace: "/w/wes" });
      await writeConfigJson(configPath, {
        agents: {
          ownership: "explicit",
          entries: {
            tony: { $include: "./tony.json5" },
            wes: { $include: "./wes.json5" },
          },
        },
      });
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      await io.writeConfigFile({
        gateway: { mode: "local" },
        agents: {
          ownership: "explicit",
          entries: {
            tony: { workspace: "/w/tony-next" },
            wes: { workspace: "/w/wes" },
          },
        },
      } as unknown as OpenClawConfig);

      const rootAfter = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        gateway?: { mode?: string };
        agents?: { ownership?: string; entries?: Record<string, { $include?: string }> };
      };
      expect(rootAfter.gateway?.mode).toBe("local");
      expect(rootAfter.agents?.entries).toEqual({
        tony: { $include: "./tony.json5" },
        wes: { $include: "./wes.json5" },
      });
      expect(rootAfter.agents).toMatchObject({ ownership: "explicit" });
      expect(JSON.parse(await fs.readFile(tonyPath, "utf-8"))).toEqual({
        workspace: "/w/tony-next",
      });
      expect(JSON.parse(await fs.readFile(wesPath, "utf-8"))).toEqual({
        workspace: "/w/wes",
      });
    },
  );

  itWithHome(
    "adds a new agent beside include-owned entries without flattening the roster",
    async (home) => {
      const configPath = configPathForHome(home);
      const tonyPath = path.join(home, ".openclaw", "tony.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(tonyPath, { workspace: "/w/tony" });
      await writeConfigJson(configPath, {
        agents: {
          ownership: "explicit",
          entries: {
            tony: { $include: "./tony.json5" },
          },
        },
      });
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      await io.writeConfigFile({
        agents: {
          ownership: "explicit",
          entries: {
            tony: { workspace: "/w/tony" },
            worker: { workspace: "/w/worker" },
          },
        },
      } as unknown as OpenClawConfig);

      const rootAfter = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: {
          ownership?: string;
          entries?: Record<string, { $include?: string; workspace?: string }>;
        };
      };
      expect(rootAfter.agents?.entries).toEqual({
        tony: { $include: "./tony.json5" },
        worker: { workspace: "/w/worker" },
      });
      expect(JSON.parse(await fs.readFile(tonyPath, "utf-8"))).toEqual({
        workspace: "/w/tony",
      });
    },
  );

  itWithHome(
    "writes through an existing include-owned agent while adding a sibling",
    async (home) => {
      const configPath = configPathForHome(home);
      const tonyPath = path.join(home, ".openclaw", "tony.json5");
      const wesPath = path.join(home, ".openclaw", "wes.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(tonyPath, { workspace: "/w/tony" });
      await writeConfigJson(wesPath, { workspace: "/w/wes" });
      await writeConfigJson(configPath, {
        agents: {
          ownership: "explicit",
          entries: {
            tony: { $include: "./tony.json5" },
            wes: { $include: "./wes.json5" },
          },
        },
      });
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      await io.writeConfigFile({
        agents: {
          ownership: "explicit",
          entries: {
            tony: { workspace: "/w/tony-next" },
            wes: { workspace: "/w/wes" },
            worker: { workspace: "/w/worker" },
          },
        },
      } as unknown as OpenClawConfig);

      const rootAfter = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: { entries?: Record<string, unknown> };
      };
      expect(rootAfter.agents?.entries).toEqual({
        tony: { $include: "./tony.json5" },
        wes: { $include: "./wes.json5" },
        worker: { workspace: "/w/worker" },
      });
      expect(JSON.parse(await fs.readFile(tonyPath, "utf-8"))).toEqual({
        workspace: "/w/tony-next",
      });
      expect(JSON.parse(await fs.readFile(wesPath, "utf-8"))).toEqual({
        workspace: "/w/wes",
      });
    },
  );

  itWithHome(
    "writes mixed root auth and system-agent include models without flattening",
    async (home) => {
      const configPath = configPathForHome(home);
      const includePath = path.join(home, ".openclaw", "reverend-run.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(includePath, { model: { primary: "openai/gpt-5.5" } });
      await writeConfigJson(configPath, {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "reverend-run" } },
          entries: { "reverend-run": { $include: "./reverend-run.json5" } },
        },
      });
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      await io.writeConfigFile({
        wizard: { lastRunCommand: "models" },
        auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
        agents: {
          ownership: "explicit",
          defaults: {
            systemAgent: { agentId: "reverend-run" },
            models: { "openai/gpt-5.6-sol": {} },
          },
          entries: { "reverend-run": { model: { primary: "openai/gpt-5.6-sol" } } },
        },
      } as unknown as OpenClawConfig);

      const rootAfter = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        wizard?: { lastRunCommand?: string };
        auth?: { profiles?: Record<string, unknown> };
        agents?: {
          defaults?: { models?: Record<string, unknown> };
          entries?: Record<string, { $include?: string }>;
        };
      };
      expect(rootAfter.wizard?.lastRunCommand).toBe("models");
      expect(rootAfter.auth?.profiles?.["openai:default"]).toEqual({
        provider: "openai",
        mode: "oauth",
      });
      expect(rootAfter.agents?.defaults?.models).toEqual({ "openai/gpt-5.6-sol": {} });
      expect(rootAfter.agents?.entries).toEqual({
        "reverend-run": { $include: "./reverend-run.json5" },
      });
      expect(JSON.parse(await fs.readFile(includePath, "utf-8"))).toEqual({
        model: { primary: "openai/gpt-5.6-sol" },
      });
    },
  );

  itWithHome(
    "writes mixed root allowlist and include-owned provider catalogs without flattening",
    async (home) => {
      const configPath = configPathForHome(home);
      const ollamaPath = path.join(home, ".openclaw", "config", "models", "ollama.json5");
      await fs.mkdir(path.dirname(ollamaPath), { recursive: true });
      await writeConfigJson(ollamaPath, [{ id: "llama3", name: "llama3" }]);
      await writeConfigJson(configPath, {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              models: { $include: "./config/models/ollama.json5" },
            },
          },
        },
        agents: { defaults: { models: { "openai/gpt-5.6-sol": {} } } },
      });
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      await io.writeConfigFile(
        {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://127.0.0.1:11434",
                api: "ollama",
                apiKey: "ollama-local",
                models: [
                  { id: "llama3", name: "llama3" },
                  { id: "qwen3", name: "qwen3" },
                ],
              },
            },
          },
          agents: {
            defaults: {
              models: { "openai/gpt-5.6-sol": {}, "ollama/llama3": {}, "ollama/qwen3": {} },
            },
          },
        } as unknown as OpenClawConfig,
        {
          explicitSetPaths: [
            ["models", "providers", "ollama", "apiKey"],
            ["models", "providers", "ollama", "models"],
            ["agents", "defaults", "models", "openai/gpt-5.6-sol"],
            ["agents", "defaults", "models", "ollama/llama3"],
            ["agents", "defaults", "models", "ollama/qwen3"],
          ],
        },
      );

      const rootAfter = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        models?: {
          providers?: {
            ollama?: {
              apiKey?: string;
              models?: { $include?: string };
            };
          };
        };
        agents?: { defaults?: { models?: Record<string, unknown> } };
      };
      expect(rootAfter.models?.providers?.ollama?.apiKey).toBe("ollama-local");
      expect(rootAfter.models?.providers?.ollama?.models).toEqual({
        $include: "./config/models/ollama.json5",
      });
      expect(rootAfter.agents?.defaults?.models).toEqual({
        "openai/gpt-5.6-sol": {},
        "ollama/llama3": {},
        "ollama/qwen3": {},
      });
      expect(JSON.parse(await fs.readFile(ollamaPath, "utf-8"))).toEqual([
        { id: "llama3", name: "llama3" },
        { id: "qwen3", name: "qwen3" },
      ]);
    },
  );

  itWithHome(
    "leaves include-owned catalogs unchanged when mixed write preflight fails",
    async (home) => {
      const configPath = configPathForHome(home);
      const ollamaPath = path.join(home, ".openclaw", "config", "models", "ollama.json5");
      await fs.mkdir(path.dirname(ollamaPath), { recursive: true });
      await writeConfigJson(ollamaPath, [{ id: "llama3", name: "llama3" }]);
      await writeConfigJson(configPath, {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              models: { $include: "./config/models/ollama.json5" },
            },
          },
        },
        agents: { defaults: { models: { "openai/gpt-5.6-sol": {} } } },
      });
      const originalRootRaw = await fs.readFile(configPath, "utf-8");
      const originalOllamaRaw = await fs.readFile(ollamaPath, "utf-8");
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      await expect(
        io.writeConfigFile(
          {
            models: {
              providers: {
                ollama: {
                  baseUrl: "http://127.0.0.1:11434",
                  api: "ollama",
                  apiKey: "ollama-local",
                  models: [
                    { id: "llama3", name: "llama3" },
                    { id: "qwen3", name: "qwen3" },
                  ],
                },
              },
            },
            agents: {
              defaults: {
                models: { "openai/gpt-5.6-sol": {}, "ollama/llama3": {}, "ollama/qwen3": {} },
              },
            },
          } as unknown as OpenClawConfig,
          {
            explicitSetPaths: [
              ["models", "providers", "ollama", "apiKey"],
              ["models", "providers", "ollama", "models"],
              ["agents", "defaults", "models", "openai/gpt-5.6-sol"],
              ["agents", "defaults", "models", "ollama/llama3"],
              ["agents", "defaults", "models", "ollama/qwen3"],
            ],
            preCommitRuntimePreflight: async () => {
              throw new Error("preflight boom");
            },
          },
        ),
      ).rejects.toThrow("preflight boom");

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
      await expect(fs.readFile(ollamaPath, "utf-8")).resolves.toBe(originalOllamaRaw);
    },
  );

  itWithHome(
    "writes mixed root allowlist, include-owned agent, and include-owned provider catalogs",
    async (home) => {
      const configPath = configPathForHome(home);
      const agentPath = path.join(home, ".openclaw", "reverend-run.json5");
      const ollamaPath = path.join(home, ".openclaw", "config", "models", "ollama.json5");
      await fs.mkdir(path.dirname(ollamaPath), { recursive: true });
      await writeConfigJson(agentPath, { model: { primary: "openai/gpt-5.6-sol" } });
      await writeConfigJson(ollamaPath, [{ id: "llama3", name: "llama3" }]);
      await writeConfigJson(configPath, {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              models: { $include: "./config/models/ollama.json5" },
            },
          },
        },
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "reverend-run" } },
          entries: { "reverend-run": { $include: "./reverend-run.json5" } },
        },
      });
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      await io.writeConfigFile(
        {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://127.0.0.1:11434",
                api: "ollama",
                apiKey: "ollama-local",
                models: [
                  { id: "llama3", name: "llama3" },
                  { id: "qwen3", name: "qwen3" },
                ],
              },
            },
          },
          agents: {
            ownership: "explicit",
            defaults: {
              systemAgent: { agentId: "reverend-run" },
              models: { "openai/gpt-5.6-sol": {}, "ollama/llama3": {} },
            },
            entries: { "reverend-run": { model: { primary: "ollama/llama3" } } },
          },
        } as unknown as OpenClawConfig,
        {
          explicitSetPaths: [
            ["models", "providers", "ollama", "apiKey"],
            ["models", "providers", "ollama", "models"],
            ["agents", "defaults", "models", "openai/gpt-5.6-sol"],
            ["agents", "defaults", "models", "ollama/llama3"],
            ["agents", "entries", "reverend-run", "model", "primary"],
          ],
        },
      );

      const rootAfter = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        models?: {
          providers?: { ollama?: { models?: { $include?: string }; apiKey?: string } };
        };
        agents?: {
          defaults?: { models?: Record<string, unknown> };
          entries?: Record<string, { $include?: string }>;
        };
      };
      expect(rootAfter.models?.providers?.ollama?.apiKey).toBe("ollama-local");
      expect(rootAfter.models?.providers?.ollama?.models).toEqual({
        $include: "./config/models/ollama.json5",
      });
      expect(rootAfter.agents?.defaults?.models).toEqual({
        "openai/gpt-5.6-sol": {},
        "ollama/llama3": {},
      });
      expect(rootAfter.agents?.entries).toEqual({
        "reverend-run": { $include: "./reverend-run.json5" },
      });
      expect(JSON.parse(await fs.readFile(agentPath, "utf-8"))).toEqual({
        model: { primary: "ollama/llama3" },
      });
      expect(JSON.parse(await fs.readFile(ollamaPath, "utf-8"))).toEqual([
        { id: "llama3", name: "llama3" },
        { id: "qwen3", name: "qwen3" },
      ]);
    },
  );

  // Leg D boundary coverage (a-f): stage/publish/restore lifecycle edges that
  // the relocated tests above don't exercise.

  itWithHome(
    "preserves an authored env-var reference through a sibling-field mixed write",
    async (home) => {
      const configPath = configPathForHome(home);
      const tonyPath = path.join(home, ".openclaw", "tony.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(tonyPath, {
        workspace: "${TONY_TEST_WORKSPACE}",
        tools: { profile: "coding" },
      });
      await writeConfigJson(configPath, {
        agents: { ownership: "explicit", entries: { tony: { $include: "./tony.json5" } } },
      });
      const io = createFastConfigIO(home, {
        env: {
          OPENCLAW_TEST_FAST: "1",
          TONY_TEST_WORKSPACE: "/w/tony-resolved",
        } as NodeJS.ProcessEnv,
      });
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      // Sibling write: only `tools.profile` changes; `workspace` is passed at
      // its already-resolved value, as a caller reading the resolved snapshot would.
      await io.writeConfigFile({
        agents: {
          ownership: "explicit",
          entries: {
            tony: {
              workspace: "/w/tony-resolved",
              tools: { profile: "full" },
            },
          },
        },
      } as unknown as OpenClawConfig);

      const tonyAfterRaw = await fs.readFile(tonyPath, "utf-8");
      expect(tonyAfterRaw).toContain("${TONY_TEST_WORKSPACE}");
      expect(tonyAfterRaw).not.toContain("/w/tony-resolved");
      expect(JSON.parse(tonyAfterRaw)).toEqual({
        workspace: "${TONY_TEST_WORKSPACE}",
        tools: { profile: "full" },
      });
    },
  );

  itWithHome(
    "restores only the already-published include when a later publish target fails",
    async (home) => {
      const configPath = configPathForHome(home);
      // "config/models" sorts before "reverend-run.json5" by absolute path, so
      // publishStagedIncludeWrites (toSorted by targetPath) writes ollama first.
      const agentPath = path.join(home, ".openclaw", "reverend-run.json5");
      const ollamaPath = path.join(home, ".openclaw", "config", "models", "ollama.json5");
      await fs.mkdir(path.dirname(ollamaPath), { recursive: true });
      await writeConfigJson(agentPath, { model: { primary: "openai/gpt-5.6-sol" } });
      await writeConfigJson(ollamaPath, [{ id: "llama3", name: "llama3" }]);
      await writeConfigJson(configPath, {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "reverend-run" } },
          entries: { "reverend-run": { $include: "./reverend-run.json5" } },
        },
        models: {
          providers: { ollama: { models: { $include: "./config/models/ollama.json5" } } },
        },
      });
      const originalRootRaw = await fs.readFile(configPath, "utf-8");
      const originalAgentRaw = await fs.readFile(agentPath, "utf-8");
      const originalOllamaRaw = await fs.readFile(ollamaPath, "utf-8");
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      // Poisons the SECOND publish target only: reverend-run.json5's own
      // directory (home/.openclaw) loses write permission, so its durable
      // temp-file write fails after ollama.json5 (a sibling, deeper directory)
      // already published -- proving restorers are pushed incrementally.
      const agentDir = path.dirname(agentPath);
      await fs.chmod(agentDir, 0o500);
      try {
        await expect(
          io.writeConfigFile({
            agents: {
              ownership: "explicit",
              defaults: { systemAgent: { agentId: "reverend-run" } },
              entries: { "reverend-run": { model: { primary: "ollama/llama3" } } },
            },
            models: {
              providers: {
                ollama: {
                  models: [
                    { id: "llama3", name: "llama3" },
                    { id: "qwen3", name: "qwen3" },
                  ],
                },
              },
            },
          } as unknown as OpenClawConfig),
        ).rejects.toThrow();
      } finally {
        await fs.chmod(agentDir, 0o700);
      }

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
      await expect(fs.readFile(agentPath, "utf-8")).resolves.toBe(originalAgentRaw);
      await expect(fs.readFile(ollamaPath, "utf-8")).resolves.toBe(originalOllamaRaw);
    },
  );

  itWithHome(
    "rejects the write when an include changes on disk between snapshot and publish",
    async (home) => {
      const configPath = configPathForHome(home);
      const tonyPath = path.join(home, ".openclaw", "tony.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(tonyPath, { workspace: "/w/tony" });
      await writeConfigJson(configPath, {
        agents: { ownership: "explicit", entries: { tony: { $include: "./tony.json5" } } },
      });
      const originalRootRaw = await fs.readFile(configPath, "utf-8");
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      const externalRaw = `${JSON.stringify({ workspace: "/w/tony-external" }, null, 2)}\n`;
      await expect(
        io.writeConfigFile(
          {
            agents: {
              ownership: "explicit",
              entries: { tony: { workspace: "/w/tony-next" } },
            },
          } as unknown as OpenClawConfig,
          {
            // Runs after stage (bytes computed from the snapshot's previousHash)
            // and before publish's re-hash fence -- an external edit here must
            // trip publishStagedIncludeWrites's ConfigMutationConflictError.
            preCommitRuntimePreflight: async () => {
              await fs.writeFile(tonyPath, externalRaw, "utf-8");
            },
          },
        ),
      ).rejects.toThrow(ConfigMutationConflictError);

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
      await expect(fs.readFile(tonyPath, "utf-8")).resolves.toBe(externalRaw);
    },
  );

  itWithHome(
    "rejects the write when an include changed after the load that captured its hash",
    async (home) => {
      const configPath = configPathForHome(home);
      const tonyPath = path.join(home, ".openclaw", "tony.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(tonyPath, { workspace: "/w/tony" });
      await writeConfigJson(configPath, {
        agents: { ownership: "explicit", entries: { tony: { $include: "./tony.json5" } } },
      });
      const originalRootRaw = await fs.readFile(configPath, "utf-8");
      const loadRaw = await fs.readFile(tonyPath, "utf-8");
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      // A mutation flow captured this include's hash at load time; the include
      // then changes on disk before the write begins. stageIncludeWriteThrough's
      // snapshot-to-stage fence must conflict instead of projecting stale state.
      const includeKey = path.normalize(tonyPath);
      const externalRaw = `${JSON.stringify({ workspace: "/w/tony-external" }, null, 2)}\n`;
      await fs.writeFile(tonyPath, externalRaw, "utf-8");
      await expect(
        io.writeConfigFile(
          {
            agents: {
              ownership: "explicit",
              entries: { tony: { workspace: "/w/tony-next" } },
            },
          } as unknown as OpenClawConfig,
          {
            includeFileHashesForWrite: { [includeKey]: hashConfigIncludeRaw(loadRaw) },
            includeFileTargetsForWrite: { [includeKey]: includeKey },
          },
        ),
      ).rejects.toThrow(ConfigMutationConflictError);

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
      await expect(fs.readFile(tonyPath, "utf-8")).resolves.toBe(externalRaw);
    },
  );

  itWithHome("publishes include-owned writes from a guarded mutation flow", async (home) => {
    const configPath = configPathForHome(home);
    const tonyPath = path.join(home, ".openclaw", "tony.json5");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeConfigJson(tonyPath, { workspace: "/w/tony" });
    await writeConfigJson(configPath, {
      agents: { ownership: "explicit", entries: { tony: { $include: "./tony.json5" } } },
    });
    const io = createFastConfigIO(home);
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(true);

    // Mutation flows hold the root's write lock with a live source guard;
    // the include's child lock must inherit that authority instead of
    // refusing with "no live source ownership".
    await withConfigWriteLock(
      configPath,
      async () => {
        await io.writeConfigFile({
          agents: {
            ownership: "explicit",
            entries: { tony: { workspace: "/w/tony-next" } },
          },
        } as unknown as OpenClawConfig);
      },
      process.env,
      () => {},
    );

    expect(JSON.parse(await fs.readFile(tonyPath, "utf-8"))).toMatchObject({
      workspace: "/w/tony-next",
    });
    const rootAfter = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      agents?: { entries?: { tony?: { $include?: string } } };
    };
    expect(rootAfter.agents?.entries?.tony).toEqual({ $include: "./tony.json5" });
  });

  itWithHome(
    "restores includes when root commit fails after config selection changes",
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
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      // beforeCommit both fails the root commit and revokes selection;
      // compensation must still restore the published include.
      let selectionLost = false;
      await expect(
        io.writeConfigFile(
          {
            agents: {
              ownership: "explicit",
              entries: { tony: { workspace: "/w/tony-next" } },
            },
          } as unknown as OpenClawConfig,
          {
            assertConfigPathForWrite: () => {
              if (selectionLost) {
                throw new Error("config selection changed");
              }
            },
            beforeCommit: async () => {
              selectionLost = true;
              throw new Error("root commit refused");
            },
          },
        ),
      ).rejects.toThrow();

      await expect(fs.readFile(tonyPath, "utf-8")).resolves.toBe(originalTonyRaw);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
    },
  );

  itWithHome(
    "preserves an authored tilde workspace through a sibling-field mixed write",
    async (home) => {
      const configPath = configPathForHome(home);
      const tonyPath = path.join(home, ".openclaw", "tony.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(tonyPath, { name: "tony", workspace: "~/agent-w" });
      await writeConfigJson(configPath, {
        agents: { ownership: "explicit", entries: { tony: { $include: "./tony.json5" } } },
      });
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      // Runtime materialization expands ~; changing a sibling field queues the
      // whole entry, and the staged bytes must keep the portable authored path.
      await io.writeConfigFile({
        agents: {
          ownership: "explicit",
          entries: { tony: { name: "tony-two", workspace: path.join(home, "agent-w") } },
        },
      } as unknown as OpenClawConfig);

      const tonyAfter = JSON.parse(await fs.readFile(tonyPath, "utf-8")) as {
        name?: string;
        workspace?: string;
      };
      expect(tonyAfter.name).toBe("tony-two");
      expect(tonyAfter.workspace).toBe("~/agent-w");
    },
  );

  itWithHome(
    "does not clobber an external include edit made after publish when root commit fails",
    async (home) => {
      const configPath = configPathForHome(home);
      const tonyPath = path.join(home, ".openclaw", "tony.json5");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeConfigJson(tonyPath, { workspace: "/w/tony" });
      await writeConfigJson(configPath, {
        agents: { ownership: "explicit", entries: { tony: { $include: "./tony.json5" } } },
      });
      const originalRootRaw = await fs.readFile(configPath, "utf-8");
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      const externalRaw = `${JSON.stringify({ workspace: "/w/tony-external-after-publish" }, null, 2)}\n`;
      await expect(
        io.writeConfigFile(
          {
            agents: {
              ownership: "explicit",
              entries: { tony: { workspace: "/w/tony-next" } },
            },
          } as unknown as OpenClawConfig,
          {
            // Runs after publishStagedIncludeWrites (tony.json5 already holds
            // the staged bytes) and before the root file's own publish() --
            // the external edit here must survive restore-only-if-unchanged.
            beforeCommit: async () => {
              await fs.writeFile(tonyPath, externalRaw, "utf-8");
              throw new Error("root commit revoked");
            },
          },
        ),
      ).rejects.toThrow("root commit revoked");

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
      await expect(fs.readFile(tonyPath, "utf-8")).resolves.toBe(externalRaw);
    },
  );

  itWithHome(
    "restores the include with the root when post-commit runtime finalization fails",
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

            // Drives the real io.runtime.ts finalize path: the root commits,
            // then runtime finalization fails, then configWritePostCommitRollback
            // must restore both the root and every published include.
            await expect(
              writeConfigFile({
                agents: {
                  ownership: "explicit",
                  entries: { tony: { workspace: "/w/tony-next" } },
                },
              } as unknown as OpenClawConfig),
            ).rejects.toThrow(/runtime snapshot refresh failed: synthetic refresh failure/);
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
    "changes no include file when authority is revoked before the first include publish",
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
      const io = createFastConfigIO(home);
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);

      // preCommitRuntimePreflight runs once staging is done, right before
      // io.write.ts enters its commit try block (which starts by asserting,
      // then calls publishStagedIncludeWrites). Arming the revoke flag there
      // makes the very next assert -- the first one inside the commit window,
      // strictly before any include publish -- the one that throws.
      let revoked = false;
      await expect(
        io.writeConfigFile(
          {
            agents: {
              ownership: "explicit",
              entries: { tony: { workspace: "/w/tony-next" } },
            },
          } as unknown as OpenClawConfig,
          {
            preCommitRuntimePreflight: async () => {
              revoked = true;
            },
            assertConfigPathForWrite: () => {
              if (revoked) {
                throw new Error("authority revoked before include publish");
              }
            },
          },
        ),
      ).rejects.toThrow("authority revoked before include publish");

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(originalRootRaw);
      await expect(fs.readFile(tonyPath, "utf-8")).resolves.toBe(originalTonyRaw);
    },
  );
});
