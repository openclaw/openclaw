import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { completionModelDefinition } from "../agents/simple-completion.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runtimeToolSchemaCheck } from "../flows/doctor-tool-schema-check.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import type { HealthCheckContext } from "../flows/health-checks.js";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import { acquirePluginRegistryForInspection } from "../plugins/loader-runtime-load.js";
import {
  createPluginCache,
  retirePluginCache,
  withPluginCache,
  type PluginCache,
} from "../plugins/plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "../plugins/plugin-instance-module-loader.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { settlePluginNativeAdmissions } from "../plugins/plugin-native-admission-state.js";
import {
  readPersistedInstalledPluginIndexRowSync,
  seedInstalledPluginIndex,
} from "../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorLintCliInProcess } from "./doctor-lint-runner.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { createDoctorPluginMetadataSnapshotScope } from "./doctor/shared/plugin-metadata-snapshot-scope.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const contributions = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../flows/doctor-health-contributions.js", () => ({
  resolveDoctorContributionHealthChecks: contributions.resolve,
}));

afterEach(() => {
  vi.restoreAllMocks();
  clearHealthChecksForTest();
});

function writeFiles(root: string, files: Record<string, string | object>) {
  for (const [file, contents] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(root, file),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }
}

it("keeps private Doctor native admissions out of the caller and persisted index with prepared metadata", async () => {
  await withOpenClawTestState(
    {
      label: "doctor-native-admission",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined },
    },
    async (state) => {
      clearHealthChecksForTest();
      const pluginId = "native-fixture";
      const toolName = "native_fixture";
      const observedCapture = state.path("observed-native-capture.txt");
      const packageDir = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName: "native-fixture-package",
        pluginId,
        version: "1.0.0",
      });
      writeFiles(packageDir, {
        "package.json": {
          ...JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")),
          type: "module",
        },
        "openclaw.plugin.json": {
          id: pluginId,
          contracts: { tools: [toolName] },
          configSchema: { type: "object", additionalProperties: false },
        },
        "README.md": "Native companion fixture.\n",
        "dist/fixture.bin": "native fixture bytes",
        "dist/index.js": `
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export default {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    const binary = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture.bin"));
    fs.writeFileSync(${JSON.stringify(observedCapture)}, [
      process.env.OPENCLAW_STATE_DIR,
      binary,
      fs.readFileSync(binary, "utf8"),
    ].join("\\t"));
    api.registerTool({
      name: ${JSON.stringify(toolName)},
      label: "Native fixture",
      description: "Synthetic tool backed by an admitted native companion",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ content: [{ type: "text", text: "unused" }] }),
    });
  },
};
`,
      });
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" }, model: "fixture/local" },
          entries: { main: { workspace: state.workspaceDir, tools: { allow: [toolName] } } },
        },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:1/v1",
              models: [completionModelDefinition({ id: "local" })],
            },
          },
        },
        memory: { search: { enabled: false } },
        plugins: {
          allow: [pluginId],
          entries: { [pluginId]: { enabled: true } },
          load: { paths: [packageDir] },
          slots: { memory: "none" },
        },
      };
      await state.writeConfig(config);
      // ClawHub npm artifacts use managed capture custody, not retained npm references.
      await seedInstalledPluginIndex(
        { [pluginId]: { source: "clawhub", installPath: packageDir } },
        { config, env: state.env },
      );
      await using parent = createPluginCache();
      await using fresh = createPluginCache();
      const readIndex = () => readPersistedInstalledPluginIndexRowSync({ env: state.env });
      const before = readIndex();
      expect(before).toBeDefined();
      const baseSnapshot = withPluginCache(parent, () =>
        loadPluginMetadataSnapshot({ config, env: state.env }),
      );
      const prepared = createDoctorPluginMetadataSnapshotScope({
        getBaseSnapshot: () => baseSnapshot,
        env: state.env,
      });
      const check = {
        ...runtimeToolSchemaCheck,
        detect: (ctx: HealthCheckContext) =>
          runtimeToolSchemaCheck.detect({
            ...ctx,
            runWithPluginMetadataSnapshot: prepared.run,
          }),
      };
      contributions.resolve.mockResolvedValue([check]);
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const inspect = async (cache: PluginCache) => {
        const inspection = await withPluginCache(cache, () =>
          acquirePluginRegistryForInspection({
            config,
            env: state.env,
            onlyPluginIds: [pluginId],
          }),
        );
        try {
          expect
            .soft(inspection.registry.plugins)
            .toContainEqual(expect.objectContaining({ id: pluginId, status: "loaded" }));
        } finally {
          await inspection.release();
        }
      };
      const exitCode = await withPluginCache(parent, () =>
        runDoctorLintCli(createTestRuntime(), { json: true, onlyIds: [check.id] }),
      );
      const report = String(stdout.mock.calls.at(-1)?.[0]);
      expect(exitCode, report).toBe(0);
      expect(JSON.parse(report)).toMatchObject({ ok: true, checksRun: 1, findings: [] });
      const [privateStateDir = "", binary = "", bytes = ""] = fs
        .readFileSync(observedCapture, "utf8")
        .split("\t");
      expect(bytes).toBe("native fixture bytes");
      expect(privateStateDir).not.toBe(state.stateDir);
      const captureRoot = path.relative(fs.realpathSync(tmpdir()), binary).split(path.sep)[0];
      expect(captureRoot).toMatch(/^openclaw-plugin-captures-[a-f0-9]{32}-/);
      expect(binary.startsWith(`${fs.realpathSync(state.stateDir)}${path.sep}`)).toBe(false);
      expect(binary.startsWith(`${privateStateDir}${path.sep}`)).toBe(false);
      expect(fs.existsSync(privateStateDir)).toBe(false);
      expect(fs.readFileSync(binary, "utf8")).toBe("native fixture bytes");
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);

      // Retirement retries pending receipts after lint has restored the caller's state view.
      await settlePluginNativeAdmissions(parent);
      expect.soft(readIndex()).toEqual(before);
      await inspect(parent);
      expect.soft((await retirePluginCache(parent)).failures).toEqual([]);

      const persisted = await withPluginCache(fresh, () =>
        readPersistedInstalledPluginIndex({ env: state.env }),
      );
      for (const plugin of persisted?.plugins ?? []) {
        for (const receipt of Object.values(plugin.sourceAdmissions ?? {})) {
          for (const native of Object.values(receipt.nativeArtifacts)) {
            expect
              .soft(native.capturedPath.startsWith(`${privateStateDir}${path.sep}`))
              .toBe(false);
            expect.soft(fs.existsSync(native.capturedPath)).toBe(true);
          }
        }
      }
      await inspect(fresh);
    },
  );
});

it("keeps native plugin captures alive after Doctor retires its private state snapshot", async () => {
  await withOpenClawTestState({ prefix: "doctor-plugin-captures-" }, async (state) => {
    await state.writeConfig({ gateway: { mode: "local" }, plugins: { enabled: false } });
    openOpenClawStateDatabase();
    await closeOpenClawStateDatabaseAsync();
    const plugin = state.path("channel-plugin");
    fs.mkdirSync(plugin);
    writeFiles(plugin, {
      "package.json": { name: "channel-fixture" },
      "README.md": "channel companion",
      "addon.node": "synthetic native bytes",
      "index.cjs": `const fs = require("node:fs");
       const path = require("node:path");
       exports.read = () => {
         const native = fs.realpathSync(path.join(__dirname, "addon.node"));
         return fs.readFileSync(path.join(path.dirname(native), "README.md"), "utf8");
       };`,
    });
    const cache = createPluginCache();
    const instances: PluginInstance[] = [];
    const load = () => {
      const instance = new PluginInstance("channel-fixture");
      instances.push(instance);
      const source = path.join(plugin, "index.cjs");
      bindPluginInstanceModuleLoader({ instance, origin: "config", source, rootDir: plugin });
      return instance.loadModule(source) as { read(): string };
    };
    let first: ReturnType<typeof load> | undefined;
    let privateState = "";
    contributions.resolve.mockResolvedValue([
      {
        id: runtimeToolSchemaCheck.id,
        kind: "core",
        description: "Inspect channel plugin",
        async detect() {
          privateState = process.env.OPENCLAW_STATE_DIR!;
          first = load();
          expect(first.read()).toBe("channel companion");
          expect(fs.existsSync(path.join(privateState, "tmp", "plugin-captures"))).toBe(false);
          return [];
        },
      },
    ]);
    clearHealthChecksForTest();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await withPluginCache(cache, async () => {
        const exitCode = await runDoctorLintCliInProcess(createTestRuntime(), {
          json: true,
          onlyIds: [runtimeToolSchemaCheck.id],
        });
        expect(exitCode).toBe(0);
        expect(privateState).not.toBe(state.stateDir);
        expect(fs.existsSync(privateState)).toBe(false);
        expect(first?.read()).toBe("channel companion");
        // Channel setup loads again after the inspection snapshot has retired.
        expect(load().read()).toBe("channel companion");
      });
    } finally {
      for (const instance of instances) {
        await instance.dispose();
      }
      await retirePluginCache(cache);
    }
  });
});
