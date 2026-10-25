import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPostCorePluginUpdateResult } from "../cli/update-cli/update-command-plugins-internals.js";
import { applyPostPluginUpdateReadiness } from "../cli/update-cli/update-command-post-plugin-readiness.js";
import { createConfigIO } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import { parseUpdateDoctorLintReport } from "../infra/update-doctor-lint.js";
import { discoverConfiguredPluginLoadPaths } from "../plugins/discovery.js";
import * as manifestRegistry from "../plugins/manifest-registry.js";
import * as pluginCacheFiles from "../plugins/plugin-cache-files.js";
import { resetPluginCache } from "../plugins/plugin-cache.js";
import * as exec from "../process/exec.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { maybeRepairInvalidPluginConfig } from "./doctor/shared/invalid-plugin-config.js";
import { inspectPluginMigrationAvailability } from "./doctor/shared/plugin-migration-availability.js";
import { repairStaleAgentModelRefs } from "./doctor/shared/stale-agent-model-ref-repair.js";
import { maybeRepairStalePluginConfig } from "./doctor/shared/stale-plugin-config.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stdout: MockInstance<typeof process.stdout.write>;
beforeEach(() => {
  clearHealthChecksForTest();
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  resetPluginCache();
  clearHealthChecksForTest();
  vi.restoreAllMocks();
});

function fixture(prefix: string, publishConfig = false) {
  const root = tempDirs.make(prefix);
  const configPath = path.join(root, "openclaw.json");
  const io = () => createConfigIO({ configPath, observe: false });
  const env = {
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
    OPENCLAW_UPDATE_IN_PROGRESS: "0",
    OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
  };
  return {
    root,
    configPath,
    io,
    env,
    configEnv: {
      ...env,
      OPENCLAW_CONFIG_PATH: configPath,
      ...(publishConfig ? { OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1" } : {}),
    },
    config: (plugins: OpenClawConfig["plugins"]): OpenClawConfig => ({
      gateway: { mode: "local" },
      agents: { defaults: { workspace: root } },
      plugins,
    }),
    write: (config: OpenClawConfig) => {
      const authored = `// Preserve authored formatting.\n${JSON.stringify(config, null, 4)}\n`;
      fs.writeFileSync(configPath, authored);
      return authored;
    },
    snapshot: () => io().readConfigFileSnapshot(),
    expectAuthored: (authored: string) =>
      expect(fs.readFileSync(configPath, "utf8")).toBe(authored),
  };
}
function writePlugin(
  directory: string,
  manifest: object,
  source = "throw new Error('must not execute');\n",
) {
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "openclaw.plugin.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, "index.js"), source);
}
function expectUninspectedConfig(config: OpenClawConfig) {
  expect(maybeRepairStalePluginConfig(config).config).toEqual(config);
  expect(maybeRepairInvalidPluginConfig(config).config).toEqual(config);
  expect(applyPluginAutoEnable({ config }).config).toEqual(config);
}
function expectIncludes(values: unknown[], fields: object) {
  expect(values).toContainEqual(expect.objectContaining(fields));
}
async function lintFinalConfig() {
  expect(
    await runDoctorLintCli(createTestRuntime(), {
      json: true,
      severityMin: "error",
      onlyIds: ["core/doctor/final-config-validation"],
    }),
  ).toBe(0);
  const text = String(stdout.mock.calls.at(-1)?.[0]);
  expect(JSON.parse(text)).toMatchObject({ ok: true, checksRun: 1, findings: [] });
  return text;
}

it.each([
  { pluginApi: "=2026.9.5", phase: "discovery" },
  { pluginApi: 20260905, phase: "discovery" },
  { pluginApi: "=2026.9.5", phase: "manifest registry" },
])("preserves rejected plugin policy ($phase, $pluginApi)", async ({ pluginApi, phase }) => {
  const { root, env } = fixture("openclaw-plugin-compatibility-");
  const pluginPath = path.join(root, "local-plugin");
  const pluginId = "compatibility-fixture";
  writePlugin(pluginPath, {
    id: pluginId,
    configSchema: { type: "object", properties: { retained: { type: "string" } } },
  });
  fs.writeFileSync(
    path.join(pluginPath, "package.json"),
    JSON.stringify({
      name: pluginId,
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"], compat: { pluginApi } },
    }),
  );
  const config: OpenClawConfig = {
    plugins: {
      allow: [pluginId],
      load: { paths: [pluginPath] },
      entries: { [pluginId]: { enabled: true, config: { retained: "authored" } } },
    },
  };
  await withEnvAsync({ ...env, OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.6" }, async () => {
    const discovery = discoverConfiguredPluginLoadPaths({ loadPaths: [pluginPath] });
    expect(discovery.candidates).toEqual([]);
    let diagnostics = discovery.diagnostics;
    if (phase === "manifest registry") {
      const previous = discoverConfiguredPluginLoadPaths({
        loadPaths: [pluginPath],
        env: { ...process.env, OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.5" },
      });
      expect(previous.candidates).toHaveLength(1);
      const registry = manifestRegistry.loadPluginManifestRegistryCore({
        candidates: previous.candidates,
        installRecords: {},
      });
      expect(registry.plugins).toEqual([]);
      vi.spyOn(manifestRegistry, "loadPluginManifestRegistryCore").mockReturnValue(registry);
      diagnostics = registry.diagnostics;
    }
    expect(maybeRepairStalePluginConfig(config)).toEqual({ config, changes: [] });
    expectIncludes(diagnostics, { pluginId, level: "warn", configDisposition: "preserve" });
  });
});

const blockedPaths = ["world-writable"];
if (process.getuid && process.getuid() !== 0) {
  blockedPaths.push("suspicious ownership");
}
it.skipIf(process.platform === "win32").each(blockedPaths)(
  "preserves blocked plugin policy through publication (%s)",
  async (block) => {
    const f = fixture("openclaw-blocked-plugin-publication-");
    const pluginId = "blocked-fixture";
    const pluginPath = path.join(f.root, "directory-alias");
    writePlugin(pluginPath, { id: pluginId, configSchema: { type: "object" } });
    const entry = {
      enabled: true,
      hooks: { allowPromptInjection: false },
      config: { nested: { retained: "authored" } },
    };
    const config = f.config({
      allow: [pluginId, "genuinely-absent"],
      deny: [pluginId, "genuinely-absent"],
      load: { paths: [pluginPath] },
      entries: { [pluginId]: entry, "genuinely-absent": { enabled: true } },
    });
    f.write(config);
    const ownerUid = fs.statSync(pluginPath).uid;
    if (block === "world-writable") {
      fs.chmodSync(pluginPath, 0o777);
    } else {
      // Keep unrelated secure-temp authority real while observing a foreign-owned plugin.
      const pluginRealPath = fs.realpathSync(pluginPath);
      const stat = pluginCacheFiles.pluginCacheStatSync;
      vi.spyOn(pluginCacheFiles, "pluginCacheStatSync").mockImplementation((...args) => {
        const observed = stat(...args);
        if (observed && (args[0] === pluginPath || args[0] === pluginRealPath)) {
          observed.uid = ownerUid + 1;
        }
        return observed;
      });
      resetPluginCache();
    }
    try {
      await withEnvAsync(f.configEnv, async () => {
        const discovery = discoverConfiguredPluginLoadPaths({ loadPaths: [pluginPath] });
        expect(discovery.candidates).toEqual([]);
        expectIncludes(discovery.diagnostics, {
          pluginId,
          level: "warn",
          message: expect.stringContaining(block),
        });
        expect(discovery.diagnostics.every((diagnostic) => !diagnostic.configDisposition)).toBe(
          true,
        );
        const migration = await inspectPluginMigrationAvailability({
          cfg: { ...config, plugins: { ...config.plugins, deny: [] } },
          env: process.env,
          installRecords: {},
          deferInstallation: false,
        });
        expectIncludes(migration.pending, {
          pluginId,
          reason: expect.stringContaining("blocked"),
          command: "openclaw doctor --fix",
        });
        expect(
          migration.pending.find((pending) => pending.pluginId === pluginId)?.reason,
        ).not.toContain("package is missing");
        const repaired = maybeRepairStalePluginConfig(config);
        const expectPolicy = (plugins: OpenClawConfig["plugins"]) => {
          expect(plugins).toMatchObject({ allow: [pluginId], deny: [pluginId] });
          expect(plugins?.entries?.[pluginId]).toEqual(entry);
          expect(plugins?.entries?.["genuinely-absent"]).toBeUndefined();
        };
        expectPolicy(repaired.config.plugins);
        const slots = { memory: pluginId, contextEngine: pluginId };
        const slotted = { ...config, plugins: { ...config.plugins, slots } };
        expect(maybeRepairStalePluginConfig(slotted).config.plugins?.slots).toEqual(slots);
        await f.io().writeConfigFile(repaired.config);
        expectPolicy(JSON.parse(fs.readFileSync(f.configPath, "utf8")).plugins);
        if (block === "world-writable") {
          fs.chmodSync(pluginPath, 0o755);
        } else {
          vi.mocked(pluginCacheFiles.pluginCacheStatSync).mockRestore();
        }
        resetPluginCache();
        expect(
          discoverConfiguredPluginLoadPaths({ loadPaths: [pluginPath] }).candidates,
        ).toHaveLength(1);
      });
    } finally {
      fs.chmodSync(pluginPath, 0o755);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "preserves chmod-000 config through Doctor and readiness",
  async () => {
    const f = fixture("openclaw-plugin-inspection-", true);
    const pluginPath = path.join(f.root, "private-plugins");
    const config = f.config({
      load: { paths: [pluginPath] },
      entries: { custom: { config: { retained: "uninspected" } } },
    });
    const authored = f.write(config);
    fs.mkdirSync(pluginPath, { recursive: true });
    fs.chmodSync(pluginPath, 0);
    try {
      await withEnvAsync(f.configEnv, async () => {
        const [diagnostic] = discoverConfiguredPluginLoadPaths({
          loadPaths: [pluginPath],
        }).diagnostics;
        assert(diagnostic, "Discovery must report the failed inspection");
        expect(diagnostic).toMatchObject({
          code: "configured-plugin-path-inspection-failed",
          configDisposition: "preserve",
          errorCode: "EACCES",
          source: pluginPath,
          message: expect.stringContaining("EACCES: permission denied"),
        });
        const failure = { errorCode: "EACCES", message: diagnostic.message };
        const guidance = `Fix permissions on ${pluginPath}, then run \`openclaw doctor --fix\`.`;
        expect(await f.snapshot()).toMatchObject({
          valid: true,
          warnings: expect.arrayContaining([
            expect.objectContaining({ code: diagnostic.code, ...failure }),
          ]),
        });
        expectUninspectedConfig(config);
        const reportText = await lintFinalConfig();
        expectIncludes(JSON.parse(reportText).warnings, {
          requirement: diagnostic.code,
          ...failure,
          severity: "warning",
          source: pluginPath,
          fixHint: guidance,
        });
        vi.spyOn(exec, "runUtf8CommandWithTimeout").mockResolvedValue(
          createCommandResult({ stdout: reportText }),
        );
        const readiness = await applyPostPluginUpdateReadiness({
          root: f.root,
          entryPath: path.join(f.root, "openclaw.mjs"),
          timeoutMs: 1_000,
          pluginUpdate: createPostCorePluginUpdateResult({ status: "ok" }),
        });
        expect(readiness).toMatchObject({
          status: "warning",
          warnings: [
            expect.objectContaining({ reason: diagnostic.code, ...failure, guidance: [guidance] }),
          ],
        });
        f.expectAuthored(authored);
      });
    } finally {
      fs.chmodSync(pluginPath, 0o700);
    }
  },
);

it("preserves custom settings and reports a typed warning for missing load paths", async () => {
  const f = fixture("openclaw-missing-load-path-", true);
  const missingPath = path.join(f.root, "unmounted-plugins");
  const fallback = path.join(f.root, "fallback-owner");
  writePlugin(
    fallback,
    {
      id: "custom-owner",
      contracts: { tools: ["custom-tool"] },
      configSchema: {
        type: "object",
        properties: { trigger: { type: "object" } },
        additionalProperties: false,
      },
    },
    "export default { register() {} };\n",
  );
  const config = f.config({
    load: { paths: [missingPath, missingPath, fallback] },
    allow: ["custom-owner"],
    deny: ["custom-disabled"],
    entries: {
      "custom-owner": { config: { nested: { retained: "verbatim" }, trigger: {} } },
    },
    slots: { memory: "custom-memory" },
  });
  config.channels = { "custom-channel": { enabled: true, retained: "verbatim" } };
  config.agents!.defaults!.model = { primary: "custom-provider/model" };
  config.agents!.defaults!.models = { "custom-provider/model": {} };
  config.tools = { web: { search: { provider: "custom-search" } } };
  const authored = f.write(config);
  await withEnvAsync({ ...f.configEnv, OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "0" }, async () => {
    const read = await f.snapshot();
    expect(read).toMatchObject({ issues: [], valid: true });
    expectIncludes(read.warnings, {
      path: "plugins.load.paths",
      code: "configured-plugin-path-unavailable",
      source: missingPath,
    });
    expectUninspectedConfig(config);
    expect(repairStaleAgentModelRefs(config).config).toEqual(config);
    const report = parseUpdateDoctorLintReport(await lintFinalConfig());
    expectIncludes(report.warnings, {
      requirement: "configured-plugin-path-unavailable",
      severity: "warning",
      source: missingPath,
      fixHint: "openclaw doctor --fix",
    });
    expect(report.warnings.map((warning) => warning.message).join("\n")).toContain(
      "Uninspected plugin configuration is preserved",
    );
    f.expectAuthored(authored);
  });
});
