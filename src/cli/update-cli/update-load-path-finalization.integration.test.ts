// Plugin discovery, convergence, CLI dispatch, config IO, and the ledger stay real.
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import * as interruption from "../../infra/update-run-interruption.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { readUpdateRunStatus } from "../../infra/update-run-status.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { seedInstalledPluginIndex } from "../../plugins/test-helpers/installed-plugin-index.js";
import { defaultRuntime } from "../../runtime.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerUpdateCli } from "../update-cli.js";
import * as postCore from "./update-command-post-core.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

const controls = vi.hoisted(() => ({ root: "" }));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveUpdateRoot: async () => controls.root,
  tryWriteCompletionCache: async () => "skipped",
}));
// Native maintenance and the fresh Doctor process have their own process proofs.
vi.mock("../../commands/doctor-maintenance.js", () => ({
  beginDoctorMaintenance: async () => undefined,
}));
vi.mock("./update-command-fresh-doctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-fresh-doctor.js")>()),
  runUpdateFinalizationDoctorInFreshProcess: async () => {},
  completePostCorePluginUpdate: async ({ pluginUpdate }: { pluginUpdate: unknown }) => ({
    pluginUpdate,
    configSnapshot: await readConfigFileSnapshot(),
  }),
}));

afterEach(() => vi.restoreAllMocks());

it.each(["finalize", "repair", "resume", "resume-unowned", "resume-write-failure"])(
  "completes %s with an operator-managed warning and preserves earlier failure evidence",
  async (command) => {
    await withOpenClawTestState({ label: `load-path-${command}` }, async (state) => {
      controls.root = state.root;
      await fs.writeFile(
        state.path("package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
      );
      await fs.mkdir(state.path("dist"));
      await fs.writeFile(
        state.path("dist/build-info.json"),
        JSON.stringify({ buildId: "installed-candidate-build" }),
      );
      const pluginId = "local-provider";
      const localDir = state.statePath("plugins-local", pluginId);
      const managedRelative = `managed/${"shadow-".repeat(34)}${pluginId}`;
      const managedDir = state.statePath(managedRelative);
      const payload = "export default { register() {} };\n";
      for (const directory of [`plugins-local/${pluginId}`, managedRelative]) {
        await state.writeJson(`${directory}/package.json`, {
          name: "@example/local-provider",
          type: "module",
          version: "1.0.0",
          openclaw: { extensions: ["./index.js"] },
        });
        await state.writeJson(`${directory}/openclaw.plugin.json`, {
          id: pluginId,
          configSchema: { type: "object" },
        });
        await state.writeText(`${directory}/index.js`, payload);
      }
      const records: Record<string, PluginInstallRecord> = {
        [pluginId]: { source: "npm", spec: "@example/local-provider", installPath: managedDir },
      };
      const config = {
        gateway: { mode: "local" as const },
        plugins: {
          allow: [pluginId],
          load: { paths: [localDir] },
          entries: { [pluginId]: { enabled: true } },
        },
      };
      await state.writeConfig(config);
      const configBytes = await fs.readFile(state.configPath, "utf8");
      await withEnvAsync({ OPENCLAW_BUNDLED_PLUGINS_DIR: state.path("no-bundled") }, async () => {
        await seedInstalledPluginIndex(records, { config, env: process.env });
        const original = createUpdateRun({ trigger: "cli" });
        recordUpdateRunStep(original.runId, {
          step: "finalize:plugins",
          status: "failed",
          detail: 'Plugin "local-provider" has no authoritative package-owner metadata.',
        });
        finishUpdateRun(original.runId, { status: "failed", reason: "finalize:plugins" });
        const retained = getUpdateRun(original.runId);
        const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
        const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
        vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
        vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
          if (code !== 0) {
            throw new Error(`CLI exited ${code}: ${errors.mock.calls.flat().join("\n")}`);
          }
          return undefined as never;
        });

        const expectedWarning = expect.objectContaining({
          pluginId,
          reason: "plugin-operator-managed",
          source: localDir,
          message: expect.stringContaining("2026.9.4"),
        });
        const expectedStep = expect.objectContaining({
          step: "warning:finalize:plugins:0",
          status: "completed",
          detail: expect.stringContaining("plugins.load.paths"),
        });
        const recordsWarning = command !== "resume-unowned" && command !== "resume-write-failure";
        if (command.startsWith("resume")) {
          const parent = createUpdateRun({ trigger: "cli" });
          if (command !== "resume-unowned") {
            adoptUpdateRun(parent.runId);
          }
          const initialParent = getUpdateRun(parent.runId);
          if (command === "resume-write-failure") {
            vi.spyOn(interruption, "recordPostCoreUpdateEvidence").mockImplementation(() => {
              throw new Error("synthetic update history is busy");
            });
          }
          const resultPath = state.path("plugins-result.json");
          const writeResult = postCore.writePostCorePluginUpdateResultFile;
          vi.spyOn(postCore, "writePostCorePluginUpdateResultFile").mockImplementationOnce(
            async (file, result) => {
              // A published parent can terminate its child as soon as this file appears.
              if (recordsWarning) {
                expect(getUpdateRun(parent.runId)?.steps).toContainEqual(expectedStep);
                expect(getUpdateRun(parent.runId)?.steps).toContainEqual(
                  expect.objectContaining({
                    step: "finalize:installed-candidate",
                    status: "completed",
                    detail: JSON.stringify({
                      version: "2026.9.4",
                      buildId: "installed-candidate-build",
                    }),
                  }),
                );
                expect(getUpdateRun(parent.runId)?.after).toEqual({});
              } else {
                expect(getUpdateRun(parent.runId)).toEqual(initialParent);
              }
              await writeResult(file, result);
            },
          );
          await withEnvAsync(
            {
              OPENCLAW_UPDATE_POST_CORE: "1",
              OPENCLAW_UPDATE_IN_PROGRESS: "1",
              OPENCLAW_UPDATE_RUN_ID: parent.runId,
              OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: resultPath,
            },
            () =>
              resumePostCoreUpdate({
                root: state.root,
                channel: "stable",
                opts: { yes: true, json: true },
                timeoutMs: 10_000,
              }),
          );
          expect(JSON.parse(await fs.readFile(resultPath, "utf8"))).toMatchObject({
            status: "warning",
            warnings: [expectedWarning],
          });
          expect(getUpdateRun(parent.runId)?.status).toBe("running");
          if (!recordsWarning) {
            const reason =
              command === "resume-unowned"
                ? "Cannot verify a live parent for the inherited update history."
                : "synthetic update history is busy";
            expect(errors).toHaveBeenCalledWith(
              `Post-core update evidence could not be saved: ${reason} Update completion may require Doctor verification.`,
            );
          }
          // Published parents close their run without projecting plugin warning rows.
          finishUpdateRun(parent.runId, { status: "succeeded" });
        } else {
          await runRegisteredCli({
            register: registerUpdateCli,
            argv: ["update", command, "--yes", "--json"],
          });
          expect(output).toHaveBeenCalledWith(
            expect.objectContaining({
              status: "warning",
              postUpdate: expect.objectContaining({
                plugins: expect.objectContaining({ warnings: [expectedWarning] }),
              }),
            }),
          );
        }
        const latest = listUpdateRuns()[0]!;
        expect(latest).toMatchObject({ status: "succeeded" });
        expect(latest.runId).not.toBe(original.runId);
        if (recordsWarning) {
          expect(latest.steps).toContainEqual(expectedStep);
        } else {
          expect(latest.steps).not.toContainEqual(expectedStep);
        }
        const runStatus = readUpdateRunStatus();
        if (runStatus.runStatusError !== undefined) {
          throw new Error(runStatus.runStatusError);
        }
        expect(runStatus.lastRun?.runId).toBe(latest.runId);
        if (recordsWarning) {
          expect(renderUpdateRunReport(latest).markdown).toContain("plugins.load.paths");
          expect(renderUpdateRunReport(latest).markdown).toContain("verify it against 2026.9.4");
        }
        expect(getUpdateRun(original.runId)).toEqual(retained);
        expect(readPersistedInstalledPluginIndexInstallRecords()).toEqual(records);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(configBytes);
        expect(await fs.readFile(`${localDir}/index.js`, "utf8")).toBe(payload);
        expect(await fs.readFile(`${managedDir}/index.js`, "utf8")).toBe(payload);
      });
    });
  },
);
