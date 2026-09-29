import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearHealthChecksForTest, getHealthCheck } from "../flows/health-check-registry.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import * as pluginRegistry from "../plugins/plugin-registry.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({ readConfigFileSnapshot: vi.fn() }));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

const runtime = createTestRuntime();

describe("Doctor lint plugin availability", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(clearHealthChecksForTest);
  afterEach(clearHealthChecksForTest);
  it("keeps update lint advisory as a configured plugin disappears and recovers", async () => {
    const root = tempDirs.make("openclaw-lint-plugin-availability-");
    const healthy = path.join(root, "healthy");
    const broken = path.join(root, "broken");
    for (const directory of [healthy, broken]) {
      fs.mkdirSync(directory);
      fs.writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({ name: "@openclaw/codex", type: "commonjs" }),
      );
    }
    fs.writeFileSync(
      path.join(healthy, "api.js"),
      `module.exports.registerCodexManagedAppServerDoctorChecks = (host) => {
        const id = "codex/managed-app-server";
        if (host.getHealthCheck(id)) return;
        host.registerHealthCheck({
          id, kind: "plugin", source: "codex", description: "Check plugin data",
          defaultEnabled: false,
          async detect() {
            require("node:fs").appendFileSync(${JSON.stringify(path.join(root, "probes"))}, "probe\\n");
            return [{ checkId: id, severity: "error", message: "Plugin data needs repair" }];
          }
        });
      };\n`,
    );
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: root,
          model: { primary: "openai/gpt-5.5" },
          models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
        },
      },
    };
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: cfg,
      path: path.join(root, "openclaw.json"),
    });
    const registry = vi.spyOn(pluginRegistry, "loadPluginManifestRegistryForPluginRegistry");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
          OPENCLAW_UPDATE_IN_PROGRESS: "0",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
        async () => {
          for (const state of [
            "missing",
            "healthy",
            "broken",
            "missing",
            "untrusted",
            "healthy",
          ] as const) {
            registry.mockReturnValue({
              plugins:
                state === "missing"
                  ? []
                  : [
                      createPluginManifestRecordFixture({
                        id: "codex",
                        origin: "global",
                        trustedOfficialInstall: state !== "untrusted",
                        doctorHealthChecks: true,
                        rootDir: state === "healthy" ? healthy : broken,
                      }),
                    ],
              diagnostics: [],
            });
            expect(
              await runDoctorLintCli(runtime, {
                json: true,
                severityMin: "error",
                onlyIds: ["core/doctor/codex-session-routes"],
              }),
            ).toBe(0);
            const output = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
            expect(output).toMatchObject({ ok: true, findings: [] });
            if (state === "healthy") {
              expect(output.warnings).toBeUndefined();
            } else {
              expect(output.warnings).toEqual([
                expect.objectContaining({
                  source: "codex",
                  severity: "warning",
                  message: expect.stringContaining("unavailable"),
                }),
              ]);
              expect(JSON.stringify(output.warnings)).toContain("openclaw doctor --fix");
            }
            if (getHealthCheck("codex/managed-app-server")) {
              const probesBefore = fs.readFileSync(path.join(root, "probes"), {
                encoding: "utf8",
                flag: "a+",
              });
              expect(
                await runDoctorLintCli(runtime, {
                  json: true,
                  severityMin: "error",
                  onlyIds: ["codex/managed-app-server"],
                }),
              ).toBe(state === "healthy" ? 1 : 0);
              const selectedOutput = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
              expect(fs.readFileSync(path.join(root, "probes"), "utf8")).toBe(
                probesBefore + (state === "healthy" ? "probe\n" : ""),
              );
              if (state === "healthy") {
                expect(selectedOutput.findings).toEqual([
                  expect.objectContaining({
                    severity: "error",
                    message: "Plugin data needs repair",
                  }),
                ]);
              } else {
                expect(selectedOutput.warnings).toEqual([
                  expect.objectContaining({ source: "codex", severity: "warning" }),
                ]);
              }
            }
          }
        },
      );
    } finally {
      registry.mockRestore();
      stdout.mockRestore();
    }
  });
});
