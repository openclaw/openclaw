import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { waitForFixtureFile } from "../../../test/helpers/process-wait.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { readPersistedInstalledPluginIndexRowSync } from "../../plugins/installed-plugin-index-record-state.js";
import { seedInstalledPluginIndex } from "../../plugins/test-helpers/installed-plugin-index.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { VERSION } from "../../version.js";
import {
  candidateAuthorityBundledPluginsDir,
  candidateAuthorityWorker,
  writeCandidateAuthorityEntrypoints,
} from "./update-command-candidate-authority.test-support.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import type { MigratedUpdateFinalizationInput } from "./update-command-migrated-types.js";

afterEach(() => vi.restoreAllMocks());

type BoundaryObservation = {
  event: string;
  role: string;
  pid: number;
  ppid: number;
  source: string;
  doctorAuthority?: boolean;
};

it.each(["healthy", "candidate-owner-replaced", "doctor-owner-replaced"] as const)(
  "composes migrated candidate, plugin/config publication and fresh Doctor: %s",
  async (fault) => {
    await withOpenClawTestState(
      {
        label: `candidate-authority-${fault}`,
        env: {
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_TEST_RUNTIME_LOG: "1",
          OPENCLAW_GATEWAY_TOKEN: "candidate-authority-test-token",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: candidateAuthorityBundledPluginsDir,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        },
      },
      async (state) => {
        const root = state.path("install");
        const control = state.path("control");
        fs.mkdirSync(root);
        fs.mkdirSync(control);
        fs.writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", type: "module", version: VERSION }),
        );
        vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        const currentConfig = {
          plugins: { enabled: false },
          agents: { defaults: { workspace: state.workspaceDir } },
          gateway: {
            mode: "local",
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
            },
            nodes: {
              commands: {
                deny: [
                  "camera.snap",
                  "camera.clip",
                  "screen.record",
                  "computer.act",
                  "mobile.ui.observe",
                  "mobile.ui.act",
                  "contacts.add",
                  "calendar.add",
                  "reminders.add",
                  "sms.send",
                  "sms.search",
                  "health.summary",
                ],
              },
            },
          },
        };
        const authoredChannels = { telegram: { enabled: false } };
        await state.writeConfig({ ...currentConfig, channels: authoredChannels });
        const configSnapshot = await readConfigFileSnapshot({
          skipPluginValidation: true,
          observe: false,
        });
        expect(configSnapshot.valid).toBe(true);
        await state.writeConfig(currentConfig);
        await seedInstalledPluginIndex({}, { config: configSnapshot.config, env: state.env });
        const originalConfig = fs.readFileSync(state.configPath, "utf8");
        const readIndex = () => readPersistedInstalledPluginIndexRowSync({ env: state.env });
        const originalIndex = readIndex();
        const events = state.path("candidate-events.jsonl");
        const readyPath = state.path("ready");
        const proceed = state.path("proceed");
        const workerPath = writeCandidateAuthorityEntrypoints({
          root,
          events,
          ready: readyPath,
          proceed,
          boundary: fault === "candidate-owner-replaced" ? "candidate" : "doctor",
        });
        const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
        const resultPath = state.path("result.json");
        let boundPid: number | undefined;
        let configAtBoundary: string | undefined;
        let indexAtBoundary: ReturnType<typeof readIndex>;
        let observation: BoundaryObservation | undefined;
        let stdout = "";
        let stderr = "";
        const work = withUpdateCommandExecutor(run.runId, async (owner) => {
          const fence = await owner.enter(root);
          return await withUpdateCommandExecutorChild(fence, root, async (grant, bindChild) => {
            const input: MigratedUpdateFinalizationInput = {
              executor: grant,
              bufferedSteps: [],
              resultPath,
              params: {
                root,
                result: {
                  status: "skipped",
                  reason: "already-current",
                  mode: "npm",
                  root,
                  steps: [],
                  durationMs: 0,
                },
                coreAlreadyCurrent: true,
                mutationStarted: false,
                shouldRestart: false,
                installKindChanged: false,
                configSnapshot,
                requestedChannel: null,
                storedChannel: "stable",
                channel: "stable",
                downgradeRisk: false,
                opts: { json: true, yes: true, run: { runId: run.runId, env: state.env } },
                controlPlaneUpdateSentinelMeta: null,
                preUpdatePluginInstallRecords: {},
                startedAt: Date.now(),
                updateStepTimeoutMs: 60_000,
                rollbackBlockedReason: "state-migrated-no-rollback",
              },
            };
            const pending = runUtf8CommandWithTimeout([process.execPath, workerPath], {
              input: JSON.stringify(input),
              env: state.env,
              beforeInput: (pid) => {
                boundPid = pid;
                bindChild(pid);
              },
              timeoutMs: 90_000,
              killProcessTree: true,
              requireProcessTreeExtinction: true,
              onOutputChunk: (chunk, stream) => {
                if (stream === "stderr") {
                  stderr += String(chunk);
                } else {
                  stdout += String(chunk);
                }
              },
            });
            try {
              await waitForFixtureFile(readyPath, pending);
              const boundary: BoundaryObservation = JSON.parse(fs.readFileSync(readyPath, "utf8"));
              observation = boundary;
              expect(observation.source).toBe(candidateAuthorityWorker.href);
              if (fault === "candidate-owner-replaced") {
                expect(observation.pid).toBe(boundPid);
                expect(observation.ppid).toBe(process.pid);
              } else {
                expect(observation.pid).not.toBe(boundPid);
                expect(observation.ppid).toBe(boundPid);
                expect(observation.doctorAuthority).toBe(true);
              }
              configAtBoundary = fs.readFileSync(state.configPath, "utf8");
              indexAtBoundary = readIndex();
              expect(indexAtBoundary).not.toEqual(originalIndex);
              if (fault !== "healthy") {
                const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
                try {
                  db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
                    "replacement",
                    root,
                  );
                } finally {
                  db.close();
                }
              }
            } finally {
              fs.writeFileSync(proceed, "go");
              // An assertion or malformed observation cannot abandon a live child.
              await pending;
            }
            return await pending;
          });
        });
        const outcome = await work.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        const evidence: BoundaryObservation[] = fs
          .readFileSync(events, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        console.log(
          JSON.stringify({
            fault,
            boundPid,
            parentPid: process.pid,
            observation,
            evidence,
            stdout,
            stderr,
          }),
        );
        expect(observation).toBeDefined();
        const finalConfig = JSON.parse(fs.readFileSync(state.configPath, "utf8"));
        if (fault === "healthy") {
          expect("value" in outcome && outcome.value.code === 0, stderr).toBe(true);
          expect(finalConfig.channels).toEqual(authoredChannels);
          expect(finalConfig.gateway.nodes?.commands?.deny).toBeUndefined();
          expect(
            evidence.filter((event) => event.event === "entry").map((event) => event.role),
          ).toEqual(["candidate", "doctor", "validate", "readiness"]);
          expect(JSON.parse(fs.readFileSync(resultPath, "utf8"))).toMatchObject({
            exitCode: 0,
            result: { status: "ok", postUpdate: { plugins: { changed: true, status: "ok" } } },
          });
          expect(getUpdateRun(run.runId, { env: state.env })?.status).toBe("succeeded");
        } else {
          expect("error" in outcome || outcome.value.code !== 0).toBe(true);
          expect(fs.readFileSync(state.configPath, "utf8")).toBe(configAtBoundary);
          expect(readIndex()).toEqual(indexAtBoundary);
          expect(fs.existsSync(resultPath)).toBe(false);
          if (fault === "candidate-owner-replaced") {
            expect(configAtBoundary).toBe(originalConfig);
            expect(evidence.some((event) => event.role === "doctor")).toBe(false);
          } else {
            expect(finalConfig.channels).toEqual(authoredChannels);
            expect(finalConfig.gateway.nodes.commands.deny).toEqual(
              currentConfig.gateway.nodes.commands.deny,
            );
            expect(
              evidence.some((event) => event.role === "validate" || event.role === "readiness"),
            ).toBe(false);
          }
        }
      },
    );
  },
  120_000,
);
