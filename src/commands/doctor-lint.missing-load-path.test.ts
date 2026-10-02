import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createConfigIO } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import { parseUpdateDoctorLintReport } from "../infra/update-doctor-lint.js";
import { resetPluginCache } from "../plugins/plugin-cache.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { maybeRepairInvalidPluginConfig } from "./doctor/shared/invalid-plugin-config.js";
import { repairStaleAgentModelRefs } from "./doctor/shared/stale-agent-model-ref-repair.js";
import { maybeRepairStalePluginConfig } from "./doctor/shared/stale-plugin-config.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetPluginCache);
beforeEach(clearHealthChecksForTest);
afterEach(clearHealthChecksForTest);

describe("Doctor candidate discovery with unavailable configured load paths", () => {
  it.each([
    { associated: false, postPlugin: false },
    { associated: true, postPlugin: false },
    { associated: true, postPlugin: true },
  ])(
    "preserves uninspected config and reports a typed warning (associated: $associated, post-plugin: $postPlugin)",
    async ({ associated, postPlugin }) => {
      const root = tempDirs.make("openclaw-missing-load-path-");
      const missingPath = path.join(root, "unmounted-plugins");
      const configPath = path.join(root, "openclaw.json");
      const config: OpenClawConfig = {
        gateway: { mode: "local" },
        agents: { defaults: { workspace: root } },
        plugins: { load: { paths: [missingPath, missingPath] } },
      };
      if (associated) {
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
      }
      const authored = `// Preserve authored whitespace and uninspected settings.\n${JSON.stringify(config, null, 4)}\n`;
      fs.writeFileSync(configPath, authored);
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
          OPENCLAW_UPDATE_IN_PROGRESS: "0",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: postPlugin ? "1" : "0",
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
    },
  );
});
