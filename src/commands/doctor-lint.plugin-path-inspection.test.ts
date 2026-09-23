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
import { discoverConfiguredPluginLoadPaths } from "../plugins/discovery.js";
import { resetPluginCache } from "../plugins/plugin-cache.js";
import * as exec from "../process/exec.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { maybeRepairInvalidPluginConfig } from "./doctor/shared/invalid-plugin-config.js";
import { maybeRepairStalePluginConfig } from "./doctor/shared/stale-plugin-config.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(clearHealthChecksForTest);
afterEach(() => {
  resetPluginCache();
  clearHealthChecksForTest();
  vi.restoreAllMocks();
});

it.skipIf(process.platform === "win32").each([false, true])(
  "preserves chmod-000 plugin config through Doctor and readiness (blocked ancestor: %s)",
  async (blockedAncestor) => {
    const root = tempDirs.make("openclaw-plugin-inspection-");
    const privateDirectory = path.join(root, "private-plugins");
    const pluginPath = blockedAncestor ? path.join(privateDirectory, "child") : privateDirectory;
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
