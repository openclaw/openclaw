import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyPostPluginUpdateReadiness } from "../cli/update-cli/update-command-post-plugin-readiness.js";
import { createConfigIO } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import { parseUpdateDoctorLintReport } from "../infra/update-doctor-lint.js";
import { discoverConfiguredPluginLoadPaths } from "../plugins/discovery.js";
import * as manifestRegistry from "../plugins/manifest-registry.js";
import { resetPluginCache } from "../plugins/plugin-cache.js";
import * as exec from "../process/exec.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { maybeRepairInvalidPluginConfig } from "./doctor/shared/invalid-plugin-config.js";
import { repairStaleAgentModelRefs } from "./doctor/shared/stale-agent-model-ref-repair.js";
import { maybeRepairStalePluginConfig } from "./doctor/shared/stale-plugin-config.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(clearHealthChecksForTest);
afterEach(() => {
  resetPluginCache();
  clearHealthChecksForTest();
  vi.restoreAllMocks();
});

it.each([
  { pluginApi: "=2026.9.5", phase: "discovery" },
  { pluginApi: 20260905, phase: "discovery" },
  { pluginApi: "=2026.9.5", phase: "manifest registry" },
])(
  "preserves configured plugin selection when $phase rejects plugin API $pluginApi",
  async ({ pluginApi, phase }) => {
    const root = tempDirs.make("openclaw-plugin-compatibility-");
    const pluginPath = path.join(root, "local-plugin");
    const pluginId = "compatibility-fixture";
    fs.mkdirSync(pluginPath);
    fs.writeFileSync(
      path.join(pluginPath, "package.json"),
      JSON.stringify({
        name: pluginId,
        version: "1.0.0",
        type: "module",
        openclaw: { extensions: ["./index.js"], compat: { pluginApi } },
      }),
    );
    fs.writeFileSync(
      path.join(pluginPath, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: { type: "object", properties: { retained: { type: "string" } } },
      }),
    );
    fs.writeFileSync(path.join(pluginPath, "index.js"), "throw new Error('must not execute');\n");
    const config: OpenClawConfig = {
      plugins: {
        allow: [pluginId],
        load: { paths: [pluginPath] },
        entries: { [pluginId]: { enabled: true, config: { retained: "authored" } } },
      },
    };
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.6",
        OPENCLAW_UPDATE_IN_PROGRESS: "0",
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
      async () => {
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
        expect(diagnostics).toContainEqual(
          expect.objectContaining({ pluginId, level: "warn", configDisposition: "preserve" }),
        );
      },
    );
  },
);

it.skipIf(process.platform === "win32")(
  "preserves chmod-000 plugin config through Doctor and readiness",
  async () => {
    const root = tempDirs.make("openclaw-plugin-inspection-");
    const privateDirectory = path.join(root, "private-plugins");
    const pluginPath = privateDirectory;
    const configPath = path.join(root, "openclaw.json");
    const config: OpenClawConfig = {
      gateway: { mode: "local" },
      agents: { defaults: { workspace: root } },
      plugins: {
        load: { paths: [pluginPath] },
        entries: { custom: { config: { retained: "uninspected" } } },
      },
    };
    const authored = `// Keep my formatting.\n${JSON.stringify(config, null, 4)}\n`;
    fs.writeFileSync(configPath, authored);
    fs.mkdirSync(pluginPath, { recursive: true });
    fs.chmodSync(privateDirectory, 0);
    try {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
          OPENCLAW_UPDATE_IN_PROGRESS: "0",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
        },
        async () => {
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
          const snapshot = await createConfigIO({
            configPath,
            observe: false,
          }).readConfigFileSnapshot();
          expect(snapshot.valid).toBe(true);
          expect(snapshot.warnings).toContainEqual(
            expect.objectContaining({
              code: diagnostic.code,
              errorCode: "EACCES",
              message: diagnostic.message,
            }),
          );
          expect(maybeRepairStalePluginConfig(config).config).toEqual(config);
          expect(maybeRepairInvalidPluginConfig(config).config).toEqual(config);
          expect(applyPluginAutoEnable({ config }).config).toEqual(config);
          const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
          expect(
            await runDoctorLintCli(createTestRuntime(), {
              json: true,
              severityMin: "error",
              onlyIds: ["core/doctor/final-config-validation"],
            }),
          ).toBe(0);
          const reportText = String(stdout.mock.calls.at(-1)?.[0]);
          stdout.mockRestore();
          const report = JSON.parse(reportText);
          expect(report).toMatchObject({ ok: true, checksRun: 1, findings: [] });
          expect(report.warnings).toContainEqual(
            expect.objectContaining({
              requirement: diagnostic.code,
              errorCode: "EACCES",
              severity: "warning",
              source: pluginPath,
              message: diagnostic.message,
              fixHint: `Fix permissions on ${pluginPath}, then run \`openclaw doctor --fix\`.`,
            }),
          );
          vi.spyOn(exec, "runUtf8CommandWithTimeout").mockResolvedValue({
            stdout: reportText,
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit",
          });
          const readiness = await applyPostPluginUpdateReadiness({
            root,
            entryPath: path.join(root, "openclaw.mjs"),
            timeoutMs: 1_000,
            pluginUpdate: {
              status: "ok",
              changed: false,
              integrityDrifts: [],
              sync: {
                changed: false,
                switchedToBundled: [],
                switchedToNpm: [],
                warnings: [],
                errors: [],
              },
              npm: { changed: false, outcomes: [] },
            },
          });
          expect(readiness).toMatchObject({
            status: "warning",
            warnings: [
              expect.objectContaining({
                reason: diagnostic.code,
                errorCode: "EACCES",
                message: diagnostic.message,
                guidance: [`Fix permissions on ${pluginPath}, then run \`openclaw doctor --fix\`.`],
              }),
            ],
          });
          expect(fs.readFileSync(configPath, "utf8")).toBe(authored);
        },
      );
    } finally {
      fs.chmodSync(privateDirectory, 0o700);
    }
  },
);

it("preserves custom settings and reports a typed warning for missing load paths", async () => {
  const root = tempDirs.make("openclaw-missing-load-path-");
  const missingPath = path.join(root, "unmounted-plugins");
  const configPath = path.join(root, "openclaw.json");
  const config: OpenClawConfig = {
    gateway: { mode: "local" },
    agents: { defaults: { workspace: root } },
    plugins: { load: { paths: [missingPath, missingPath] } },
  };
  const fallback = path.join(root, "fallback-owner");
  fs.mkdirSync(fallback);
  fs.writeFileSync(path.join(fallback, "index.js"), "export default { register() {} };\n");
  fs.writeFileSync(
    path.join(fallback, "openclaw.plugin.json"),
    JSON.stringify({
      id: "custom-owner",
      contracts: { tools: ["custom-tool"] },
      configSchema: {
        type: "object",
        properties: { trigger: { type: "object" } },
        additionalProperties: false,
      },
    }),
  );
  config.plugins = {
    ...config.plugins,
    load: { paths: [missingPath, missingPath, fallback] },
    allow: ["custom-owner"],
    deny: ["custom-disabled"],
    entries: {
      "custom-owner": { config: { nested: { retained: "verbatim" }, trigger: {} } },
    },
    slots: { memory: "custom-memory" },
  };
  config.channels = { "custom-channel": { enabled: true, retained: "verbatim" } };
  config.agents!.defaults!.heartbeat = { target: "custom-channel" };
  config.agents!.defaults!.model = { primary: "custom-provider/model" };
  config.agents!.defaults!.models = { "custom-provider/model": {} };
  config.tools = { web: { search: { provider: "custom-search" } } };
  const authored = `// Preserve authored whitespace and uninspected settings.\n${JSON.stringify(config, null, 4)}\n`;
  fs.writeFileSync(configPath, authored);
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
      OPENCLAW_UPDATE_IN_PROGRESS: "0",
      OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "0",
    },
    async () => {
      const snapshot = await createConfigIO({
        env: process.env,
        configPath,
        observe: false,
      }).readConfigFileSnapshot();
      expect(snapshot.issues).toEqual([]);
      expect(snapshot.valid).toBe(true);
      expect(snapshot.warnings).toContainEqual(
        expect.objectContaining({
          path: "plugins.load.paths",
          code: "configured-plugin-path-unavailable",
          source: missingPath,
        }),
      );
      expect(maybeRepairStalePluginConfig(config).config).toEqual(config);
      expect(maybeRepairInvalidPluginConfig(config).config).toEqual(config);
      expect(applyPluginAutoEnable({ config }).config).toEqual(config);
      expect(repairStaleAgentModelRefs(config).config).toEqual(config);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        expect(
          await runDoctorLintCli(createTestRuntime(), {
            json: true,
            severityMin: "error",
            onlyIds: ["core/doctor/final-config-validation"],
          }),
        ).toBe(0);
        const report = parseUpdateDoctorLintReport(String(stdout.mock.calls.at(-1)?.[0]));
        expect(report).toMatchObject({ ok: true, checksRun: 1, findings: [] });
        expect(report.warnings).toContainEqual(
          expect.objectContaining({
            requirement: "configured-plugin-path-unavailable",
            severity: "warning",
            source: missingPath,
            fixHint: "openclaw doctor --fix",
          }),
        );
        expect(report.warnings.map((warning) => warning.message).join("\n")).toContain(
          "Uninspected plugin configuration is preserved",
        );
      } finally {
        stdout.mockRestore();
      }
      expect(fs.readFileSync(configPath, "utf8")).toBe(authored);
    },
  );
});
