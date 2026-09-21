import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { prepareUpdateFailureReport } from "../infra/update-failure-report-prepare.js";
import { listUpdateRuns } from "../infra/update-run-ledger.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { updateFinalizationOutputEntrypoint } from "./cli-entrypoint.test-support.js";
import {
  formatCliProcessFailure,
  runCliProcessChild,
  waitForCliProcessStderrMarker,
} from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
// Children share a fixture-owned temporary root; each case still owns its state.
const childTempDir = useAutoCleanupTempDirTracker(afterAll).make("openclaw-update-child-tmp-");
const fixture = resolveRuntimeWorkerUrl(updateFinalizationOutputEntrypoint);
const doctorDiagnostics = [
  "OpenClaw doctor",
  "Doctor panel diagnostic",
  "Doctor workspace diagnostic",
  "Doctor console diagnostic",
  "Doctor complete.",
];
const scenarios = [
  "repair-deadline",
  "json",
  "inherited-json",
  "doctor-error",
  "doctor-warning",
  "plugin-error",
  "human",
  "human-plugin-error",
  "human-plugin-warning",
  "human-recovery-plugin-error",
];
const finalizeScenarios = [
  "json",
  "phase-hang",
  "doctor-hang",
  "doctor-progress",
  "completion-hang",
  "handle-hang",
  "borrowed-phase",
  "borrowed-output",
];

describe.each(["repair", "finalize"])("update %s process output", (command) => {
  // Both spellings share the finalization action; one matrix covers its output modes.
  it.each(command === "repair" ? scenarios : finalizeScenarios)(
    "%s preserves the output and exit contract",
    async (scenario) => {
      const root = tempDirs.make("openclaw-update-json-");
      const state = path.join(root, "state");
      const config = path.join(root, "openclaw.json");
      const workspace = path.join(root, "workspace");
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing isolated port");
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      expect(address.port).not.toBe(18789);
      await fs.mkdir(state);
      await fs.mkdir(workspace);
      await fs.writeFile(
        config,
        JSON.stringify({
          gateway: { mode: "local", port: address.port, auth: { mode: "none" } },
          plugins: { enabled: false, allow: [] },
          agents: { defaults: { workspace } },
          logging: { file: path.join(root, "openclaw.log") },
        }),
      );
      const json = !scenario.startsWith("human");
      const traceExit =
        scenario === "human-recovery-plugin-error" &&
        process.platform !== "win32" &&
        !process.versions.bun;
      const blockedPhase =
        scenario === "doctor-hang" || scenario === "doctor-progress"
          ? "doctor"
          : scenario === "phase-hang"
            ? "configSnapshot"
            : scenario === "completion-hang"
              ? "completionCache"
              : undefined;
      const args = [
        "update",
        ...(scenario === "inherited-json" ? ["--json"] : []),
        command,
        "--channel",
        "dev",
        ...(scenario === "human-recovery-plugin-error" ? [] : ["--yes"]),
        "--no-restart",
        // The fixture overrides the blocked phase to 1s; recovery keeps a separate explicit budget.
        "--timeout",
        scenario === "borrowed-phase" ? "1" : "9",
        ...(json && scenario !== "inherited-json" ? ["--json"] : []),
      ];
      const readRun = () =>
        listUpdateRuns({ limit: 1 }, { env: { HOME: root, OPENCLAW_STATE_DIR: state } })[0];
      let observedPhaseStart: ReturnType<typeof readRun> | undefined;
      let tracedChildPid: number | undefined;
      const result = await runCliProcessChild({
        nodeExecutable: testNodeExecPath,
        ...(traceExit
          ? {
              interact: (child: import("node:child_process").ChildProcessWithoutNullStreams) => {
                tracedChildPid = child.pid;
                child.stdin.end();
              },
            }
          : {}),
        ...(scenario === "phase-hang"
          ? {
              interact: async (
                child: import("node:child_process").ChildProcessWithoutNullStreams,
              ) => {
                try {
                  await waitForCliProcessStderrMarker(child, "fixture configSnapshot recorded");
                  observedPhaseStart = readRun();
                } catch (error) {
                  throw new Error("Could not read the phase-start ledger", { cause: error });
                } finally {
                  child.stdin.end();
                }
              },
            }
          : {}),
        nodeArgs: [
          ...(traceExit ? ["--trace-exit"] : []),
          ...resolveRuntimeWorkerArgv(fixture, testNodeExecPath),
          JSON.stringify(runtimeProcessEntrypoints),
          scenario,
          ...args,
        ],
        env: {
          ESBUILD_WORKER_THREADS: "0",
          PATH: path.dirname(testNodeExecPath),
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: config,
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          OPENCLAW_GATEWAY_PORT: String(address.port),
          XDG_CONFIG_HOME: path.join(root, "xdg-config"),
          XDG_DATA_HOME: path.join(root, "xdg-data"),
          XDG_CACHE_HOME: path.join(root, "xdg-cache"),
          XDG_STATE_HOME: path.join(root, "xdg-state"),
          XDG_RUNTIME_DIR: path.join(root, "xdg-runtime"),
          TMPDIR: childTempDir,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NO_COLOR: "1",
          TERM: "dumb",
        },
      });
      const failure = formatCliProcessFailure({ reason: `${command} ${scenario}`, ...result });
      expect(result.signal, failure).toBeNull();
      expect(result.code, failure).toBe(
        scenario === "repair-deadline" ||
          scenario.endsWith("error") ||
          scenario === "phase-hang" ||
          blockedPhase === "doctor"
          ? 1
          : 0,
      );
      if (scenario === "repair-deadline") {
        const output = JSON.parse(result.stdout);
        expect(output, failure).toMatchObject({ status: "failed", stuckPhase: "plugins" });
        expect(await fs.readFile(path.join(state, "managed-service-state"), "utf8"), failure).toBe(
          "running",
        );
        expect(
          (await fs.readFile(path.join(state, "managed-service-state.events"), "utf8"))
            .trim()
            .split("\n"),
          failure,
        ).toEqual(["stop", "plugins-entered", "late-write-refused", "restart"]);
        expect(JSON.parse(await fs.readFile(config, "utf8")).update, failure).toBeUndefined();
        expect(readRun(), failure).toMatchObject({
          status: "failed",
          reason: "finalization-timeout",
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: "warning:finalize:plugins:deadline",
              status: "completed",
              detail: expect.stringContaining("timed out in plugins after 1000ms"),
            }),
          ]),
        });
        expect(result.stderr, failure).toContain(
          "Gateway restarted and verified after Doctor repair.",
        );
        return;
      }
      if (blockedPhase === "doctor") {
        const output = JSON.parse(result.stdout);
        expect(output, failure).toMatchObject({ status: "failed", stuckPhase: "doctor" });
        for (const marker of ["STEP completed fixture-schema", "STEP active fixture-validation"]) {
          expect(JSON.stringify(output.doctorOutput), failure).toContain(marker);
          expect(result.stderr, failure).toContain(marker);
          expect(readRun(), failure).toMatchObject({
            status: "failed",
            steps: expect.arrayContaining([
              expect.objectContaining({
                step: "finalize:doctor",
                status: "failed",
                detail: expect.stringContaining(marker),
              }),
            ]),
          });
        }
        const timing = output.phaseTimings.find(
          (entry: { phase: string }) => entry.phase === "doctor",
        );
        expect(timing.durationMs, failure).toBeGreaterThanOrEqual(1_000);
        expect(timing.durationMs, failure).toBeLessThan(3_000);
        if (scenario === "doctor-progress") {
          expect(output.doctorOutput.stderr.excerpt, failure).toContain(
            "PROGRESS fixture-validation",
          );
        }
        return;
      }
      if (scenario.startsWith("borrowed-")) {
        expect(result.stderr, failure).toContain("Borrowed caller completed.");
        expect(result.stderr, failure).not.toContain("Process still alive after terminal output");
        if (scenario === "borrowed-phase") {
          const timing = JSON.parse(result.stdout).phaseTimings.find(
            (entry: { phase: string }) => entry.phase === "configSnapshot",
          );
          expect(timing, failure).toMatchObject({ outcome: "completed" });
          expect(timing.durationMs, failure).toBeGreaterThanOrEqual(1_000);
        }
      }
      if (blockedPhase) {
        if (scenario === "phase-hang") {
          expect(observedPhaseStart?.steps, failure).toContainEqual(
            expect.objectContaining({
              step: "finalize:configSnapshot",
              status: "in_progress",
              startedAtMs: expect.any(Number),
            }),
          );
        }
        const output = JSON.parse(result.stdout);
        expect(output).toMatchObject({
          status: scenario === "phase-hang" ? "failed" : "ok",
          restart: false,
        });
        if (scenario === "phase-hang") {
          expect(output.stuckPhase).toBe(blockedPhase);
          const pid = Number(await fs.readFile(path.join(root, "blocked-child.pid"), "utf8"));
          expect(output.childProcesses, failure).toContainEqual({
            pid,
            parentPid: expect.any(Number),
            command: expect.stringMatching(/^node(?:\.exe)?$/u),
          });
          expect(output.childProcessInspection, failure).toBe("complete");
          expect(result.stdout + result.stderr, failure).not.toContain("fixture-private-argument");
          const prerequisite = output.phaseTimings.find(
            (entry: { phase: string }) => entry.phase === "targetConfigValidation",
          );
          expect(prerequisite, failure).toMatchObject({ outcome: "completed" });
          expect(prerequisite.durationMs, failure).toBeGreaterThanOrEqual(1_000);
        } else {
          expect(output.stuckPhase).toBeUndefined();
          const pid = Number(await fs.readFile(path.join(root, "completion.pid"), "utf8"));
          expect(pid).toBeGreaterThan(0);
          expect(isPidAlive(pid)).toBe(false);
        }
        expect(output.phaseTimings).toContainEqual(
          expect.objectContaining({
            phase: blockedPhase,
            outcome: "failed",
            durationMs: expect.any(Number),
          }),
        );
        expect(result.stderr).toContain(`finalize:${blockedPhase}`);
        expect(readRun()).toMatchObject({
          status: scenario === "phase-hang" ? "failed" : "succeeded",
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: `finalize:${blockedPhase}`,
              status: "failed",
              startedAtMs: expect.any(Number),
              endedAtMs: expect.any(Number),
            }),
          ]),
        });
        return;
      }
      if (scenario === "handle-hang") {
        expect(result.stderr).toContain("activeResources");
        expect(result.stderr).toContain("unsettledDisposers");
        const pid = Number(await fs.readFile(path.join(root, "blocked-child.pid"), "utf8"));
        const diagnostic = result.stderr
          .split("\n")
          .find((line) => line.includes("Process still alive after terminal output:"));
        expect(diagnostic, failure).toBeDefined();
        const payload = JSON.parse(diagnostic!.slice(diagnostic!.indexOf("{")));
        expect(payload.childProcesses, failure).toContainEqual({
          pid,
          parentPid: expect.any(Number),
          command: expect.stringMatching(/^node(?:\.exe)?$/u),
        });
        expect(payload.unsettledDisposers, failure).toContain("fixture-stdin-child");
        expect(result.stdout + result.stderr, failure).not.toContain("fixture-private-argument");
        expect(readRun()).toMatchObject({
          status: "succeeded",
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: "finalize:exit",
              detail: expect.stringContaining("activeResources"),
            }),
          ]),
        });
      }
      const diagnostics = json ? result.stderr : result.stdout;
      for (const diagnostic of doctorDiagnostics) {
        expect(diagnostics, failure).toContain(diagnostic);
      }
      expect(diagnostics.match(/Doctor console diagnostic/gu), failure).toHaveLength(1);
      expect(result.stderr, failure).toContain("Doctor stderr diagnostic");
      if (scenario === "human-recovery-plugin-error") {
        expect(result.stdout, failure).toContain("Update finalization failed.");
        expect(result.stdout, failure).toContain("Interactive recovery completed.");
        expect(result.stderr, failure).not.toContain("Process still alive after terminal output");
        if (traceExit) {
          expect(tracedChildPid, failure).toBeGreaterThan(0);
          const diagnosticPrefix = "[cli-process-diagnostics] ";
          const stderrLines = result.stderr.split("\n");
          const exitBoundaries = stderrLines
            .map((line, lineIndex) => ({ line, lineIndex }))
            .filter(({ line }) => line.startsWith(`${diagnosticPrefix}{`))
            .map(({ line, lineIndex }) => ({
              lineIndex,
              value: JSON.parse(line.slice(diagnosticPrefix.length)),
            }))
            .filter(
              ({ value }) =>
                value.pid === tracedChildPid && value.phase?.startsWith("exit-listeners-"),
            );
          expect(
            exitBoundaries.map(({ value }) => value),
            failure,
          ).toMatchObject([
            { phase: "exit-listeners-enter", pid: tracedChildPid, exitCode: 1 },
            { phase: "exit-listeners-return", pid: tracedChildPid, exitCode: 1 },
          ]);
          const nativeExit = `(node:${tracedChildPid}) WARNING: Exited the environment with code 1`;
          const nativeExitLine = stderrLines.findIndex((line) => line.includes(nativeExit));
          for (const boundary of exitBoundaries) {
            expect(nativeExitLine, failure).toBeGreaterThan(boundary.lineIndex);
          }
        }
        return;
      }
      const triageNotice = "Update failed. Preparing triage diagnostics...";
      if (!scenario.endsWith("error")) {
        expect(result.stdout + result.stderr, failure).not.toContain(triageNotice);
        expect(result.stdout + result.stderr, failure).not.toContain("triage-fixture-prompt.md");
      }
      if (!json) {
        const terminal =
          scenario === "human-plugin-error"
            ? "Update finalization failed."
            : scenario === "human-plugin-warning"
              ? "Update finalization completed with warnings."
              : "Update finalization completed.";
        if (scenario === "human-plugin-error") {
          expect(result.stdout, failure).toContain(terminal);
          const triageIndex = result.stdout.indexOf(triageNotice);
          const promptIndex = result.stdout.indexOf("Debugging prompt:");
          const guidanceIndex = result.stdout.indexOf("Ready-to-run agent handoffs:");
          expect(triageIndex, failure).toBeGreaterThan(result.stdout.indexOf(terminal));
          expect(promptIndex, failure).toBeGreaterThan(triageIndex);
          expect(guidanceIndex, failure).toBeGreaterThan(promptIndex);
          expect(result.stdout.trimEnd().endsWith("openclaw triage --run"), failure).toBe(true);
        } else {
          expect(result.stdout.trimEnd().endsWith(terminal), failure).toBe(true);
        }
        return;
      }
      // Parse the whole pipe: accepting a suffix would hide Clack's direct stdout writes.
      const output = JSON.parse(result.stdout);
      if (scenario.endsWith("error")) {
        expect(result.stderr, failure).not.toContain("Process still alive after terminal output");
        expect(result.stderr, failure).toContain(triageNotice);
        expect(result.stderr, failure).toContain('"promptPath":');
        expect(result.stderr, failure).toContain("triage-fixture-prompt.md");
        expect(result.stderr, failure).not.toContain("Triage could not complete:");
        expect(result.stdout, failure).not.toContain("triage-fixture-prompt.md");
      }
      if (scenario === "doctor-error") {
        expect(output).toMatchObject({
          ok: false,
          error: { type: "cli_error", message: expect.stringContaining("Doctor repair failed") },
        });
        const run = readRun()!;
        expect(run, failure).toMatchObject({
          status: "failed",
          reason: "doctor-failed",
          target: { kind: "package", version: "2026.9.4" },
          steps: expect.arrayContaining([
            expect.objectContaining({ step: "finalize:doctor", status: "failed", exitCode: 1 }),
          ]),
        });
        const report = await prepareUpdateFailureReport(
          {
            attemptId: run.runId,
            recordedRun: run,
            result: { status: "error", mode: "unknown", steps: [], durationMs: 0 },
          },
          { env: { HOME: root, OPENCLAW_STATE_DIR: state }, stateDir: state },
        );
        expect(report.body).toContain("Update target: 2026.9.4");
        expect(report.body).toContain("Update mode: package");
        expect(report.body).toContain("Reason code: doctor-failed");
        expect(report.body).toContain("Failed phase finalize-doctor: exit 1");
        expect(report.body).toContain("Recovery outcome: not serving (timeout)");
        expect(run.steps.filter((step) => step.step === "gateway recovery verification")).toEqual([
          {
            step: "gateway recovery verification",
            status: "failed",
            exitCode: 1,
            detail: "Exit code: 1",
            failureFacts: [{ check: "settled", code: "timeout", message: expect.any(String) }],
          },
        ]);
        expect({
          port: run.verification.port,
          readyz: run.verification.readyz,
          settled: run.verification.settled,
          channelsReady: run.verification.channelsReady,
        }).toEqual({ port: address.port, readyz: false, settled: false, channelsReady: false });
      } else if (scenario === "doctor-warning") {
        const warning = "Optional probe failed; run openclaw doctor after updating.";
        expect(output).toMatchObject({
          status: "warning",
          postUpdate: { doctor: { status: "warning", warnings: [warning] } },
        });
        expect(readRun(), failure).toMatchObject({
          status: "succeeded",
          steps: expect.arrayContaining([
            expect.objectContaining({ step: "warning:finalize:doctor:0", detail: warning }),
          ]),
        });
      } else {
        expect(output).toMatchObject({
          status: scenario === "plugin-error" ? "error" : "ok",
          mode: "finalize",
          restart: false,
          channel: "dev",
          postUpdate: { doctor: { status: "ok" } },
        });
      }
    },
  );
});
