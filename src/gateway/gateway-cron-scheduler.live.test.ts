import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { isProcessAlive, waitForDead, waitForPidFile } from "../../test/helpers/process-wait.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { isLiveTestEnabled, logLiveProgress } from "../agents/live-test-helpers.js";
import type { CronRunLogEntry } from "../cron/run-log-types.js";
import type { CronJob } from "../cron/types.js";
import { listKnownProviderAuthEnvVarNames } from "../secrets/provider-env-vars.js";

const describeLive = isLiveTestEnabled() ? describe : describe.skip;

async function cliJson<T>(
  instance: OpenClawTestInstance,
  args: string[],
  expectedCode = 0,
): Promise<T> {
  const result = await instance.cli(
    [...args, "--url", instance.url, "--token", instance.gatewayToken, "--json"],
    { timeoutMs: 60_000 },
  );
  expect(result.code, `${args.slice(0, 2).join(" ")}: ${result.stderr}\n${result.stdout}`).toBe(
    expectedCode,
  );
  return JSON.parse(result.stdout) as T;
}

async function waitForJob(
  instance: OpenClawTestInstance,
  id: string,
  ready: (job: CronJob) => boolean,
): Promise<CronJob> {
  const deadline = Date.now() + 60_000;
  let job: CronJob;
  do {
    job = await cliJson<CronJob>(instance, ["cron", "get", id]);
    if (ready(job)) {
      return job;
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`cron state did not converge: ${JSON.stringify(job.state)}`);
}

describeLive("cron scheduling through an isolated Gateway", () => {
  it("preserves trigger intervals, stream matches, timeout output, on-exit rearming, and declaration recovery", async () => {
    const instance = await createOpenClawTestInstance({
      name: "cron-scheduler",
      env: {
        ...Object.fromEntries(listKnownProviderAuthEnvVarNames().map((name) => [name, undefined])),
        OPENCLAW_SKIP_CRON: "0",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_AGENT_RUNTIME: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
      },
    });
    await runQaGatewayFixture(
      async () => {
        const workspace = instance.state.workspaceDir;
        await instance.state.writeConfig({
          gateway: {
            mode: "local",
            port: instance.port,
            auth: { mode: "token", token: instance.gatewayToken },
            controlUi: { enabled: false },
          },
          agents: {
            defaults: { workspace, skipBootstrap: true, sandbox: { mode: "off" } },
            entries: { probe: { workspace } },
          },
          cron: { enabled: true },
        });
        await instance.startGateway();

        const conditionPath = path.join(workspace, "quiet-condition.js");
        await fs.writeFile(
          conditionPath,
          [
            "const startedAtMs = Date.now();",
            "await new Promise(resolve => setTimeout(resolve, (450 - Date.now() % 1000 + 1000) % 1000));",
            "json({ fire: false, state: { count: (trigger.state?.count ?? 0) + 1, startedAtMs } });",
          ].join("\n"),
        );
        const watcher = await cliJson<CronJob>(instance, [
          "cron",
          "add",
          "--name",
          "quiet-condition",
          "--cron",
          "* * * * * *",
          "--exact",
          "--agent",
          "probe",
          "--session",
          "main",
          "--system-event",
          "Must remain quiet",
          "--trigger-script",
          conditionPath,
          "--tools",
          "",
        ]);
        const first = await waitForJob(
          instance,
          watcher.id,
          (job) => job.state.triggerEvalCount === 1,
        );
        expect(first.state.triggerState).toMatchObject({ count: 1 });
        const firstEvalAt = first.state.lastTriggerEvalAtMs!;
        const nextEvalAt = first.state.nextRunAtMs!;
        expect(nextEvalAt - firstEvalAt).toBeGreaterThanOrEqual(30_000);
        const listed = await cliJson<{ jobs: CronJob[] }>(instance, ["cron", "list"]);
        expect(listed.jobs.find((job) => job.id === watcher.id)?.state).toMatchObject({
          triggerEvalCount: 1,
          lastTriggerEvalAtMs: firstEvalAt,
          nextRunAtMs: nextEvalAt,
        });
        await instance.stopGateway();
        await instance.startGateway();
        const restored = await cliJson<CronJob>(instance, ["cron", "get", watcher.id]);
        expect(restored.state).toMatchObject({
          triggerEvalCount: 1,
          triggerState: first.state.triggerState,
          lastTriggerEvalAtMs: firstEvalAt,
          nextRunAtMs: nextEvalAt,
        });
        const second = await waitForJob(
          instance,
          watcher.id,
          (job) => (job.state.triggerEvalCount ?? 0) >= 2,
        );
        const secondState = second.state.triggerState as { count: number; startedAtMs: number };
        expect(secondState.count).toBe(2);
        expect(secondState.startedAtMs - firstEvalAt).toBeGreaterThanOrEqual(30_000);
        expect(second.state.lastRunAtMs).toBeUndefined();
        expect(await cliJson(instance, ["cron", "runs", watcher.id])).toMatchObject({
          entries: [],
        });
        await cliJson(instance, ["cron", "rm", watcher.id]);
        logLiveProgress(
          "cron scheduler: quiet condition kept its 30-second floor through reads and restart",
        );

        const scriptPath = path.join(workspace, "capture-stream.js");
        const pidPath = path.join(workspace, "source.pid");
        await fs.writeFile(scriptPath, "json({ state: { batch: trigger.streamBatch } });\n");
        const source = [
          `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
          "console.log('build-start ' + 'x'.repeat(3000) + ' build-complete');",
          "setInterval(() => {}, 1000);",
        ].join(" ");
        const stream = await cliJson<CronJob>(instance, [
          "cron",
          "add",
          "--name",
          "full-line-match",
          "--agent",
          "probe",
          "--session",
          "isolated",
          "--no-deliver",
          "--stream-command",
          JSON.stringify([process.execPath, "-e", source]),
          "--stream-mode",
          "match",
          "--stream-match",
          "^build-start .* build-complete$",
          "--stream-batch-ms",
          "50",
          "--stream-max-batch-bytes",
          "1024",
          "--script",
          scriptPath,
          "--tools",
          "",
        ]);
        const captured = await waitForJob(
          instance,
          stream.id,
          (job) => job.state.lastRunStatus === "ok",
        );
        const batch = (captured.state.triggerState as { batch: string }).batch;
        expect(batch).toMatch(/^build-start x/u);
        expect(batch).toMatch(/\[truncated\]$/u);
        expect(Buffer.byteLength(batch)).toBeLessThanOrEqual(1024);
        expect(await cliJson(instance, ["cron", "runs", stream.id])).toMatchObject({
          entries: [{ status: "ok", completionStatus: "succeeded" }],
        });
        const sourcePid = Number(await fs.readFile(pidPath, "utf8"));
        expect(Number.isInteger(sourcePid) && sourcePid > 0).toBe(true);
        await cliJson(instance, ["cron", "disable", stream.id]);
        let sourceAlive = true;
        const stopDeadline = Date.now() + 10_000;
        do {
          try {
            process.kill(sourcePid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              throw error;
            }
            sourceAlive = false;
          }
          if (sourceAlive) {
            await delay(100);
          }
        } while (sourceAlive && Date.now() < stopDeadline);
        expect(sourceAlive, "disabled stream source is still alive").toBe(false);
        await cliJson(instance, ["cron", "rm", stream.id]);
        logLiveProgress(
          "cron scheduler: full-line stream match delivered a bounded batch and stopped on disable",
        );

        const timeout = await cliJson<CronJob>(instance, [
          "cron",
          "add",
          "--name",
          "command-timeout",
          "--every",
          "1d",
          "--agent",
          "probe",
          "--session",
          "isolated",
          "--no-deliver",
          "--command-argv",
          JSON.stringify([
            process.execPath,
            "-e",
            "console.log('synthetic progress'); setInterval(() => {}, 1000);",
          ]),
          "--timeout-seconds",
          "1",
        ]);
        const completed = await cliJson<{ run: CronRunLogEntry }>(
          instance,
          [
            "cron",
            "run",
            timeout.id,
            "--wait",
            "--wait-timeout",
            "30s",
            "--poll-interval",
            "100ms",
          ],
          1,
        );
        expect(completed).toMatchObject({
          completed: true,
          completionStatus: "failed",
          run: {
            status: "error",
            completionStatus: "failed",
            error: "command timed out",
            summary: "synthetic progress",
            diagnostics: {
              entries: [expect.objectContaining({ source: "exec", severity: "error" })],
            },
          },
        });
        const timedOut = await waitForJob(
          instance,
          timeout.id,
          (job) => job.state.lastRunStatus === "error",
        );
        expect(timedOut.state.lastErrorReason).toBe("timeout");
        await cliJson(instance, ["cron", "rm", timeout.id]);
        logLiveProgress(
          "cron scheduler: command timeout retained progress and its timeout classification",
        );

        const onExitDir = path.join(workspace, "on-exit");
        const releasePath = path.join(onExitDir, "release-first");
        const payloadCountPath = path.join(onExitDir, "payload-count");
        await fs.mkdir(onExitDir);
        await Promise.all([
          fs.writeFile(path.join(onExitDir, "watch-count"), "0"),
          fs.writeFile(payloadCountPath, "0"),
          fs.writeFile(
            path.join(onExitDir, "watch.cjs"),
            [
              "const fs = require('node:fs');",
              "const path = require('node:path');",
              "const countPath = path.join(__dirname, 'watch-count');",
              "const count = Number(fs.readFileSync(countPath, 'utf8')) + 1;",
              "fs.writeFileSync(countPath, String(count));",
              "fs.writeFileSync(path.join(__dirname, 'watch-' + count + '.pid'), String(process.pid));",
            ].join("\n"),
          ),
          fs.writeFile(
            path.join(onExitDir, "payload.cjs"),
            [
              "const fs = require('node:fs');",
              "const path = require('node:path');",
              "const countPath = path.join(__dirname, 'payload-count');",
              "const count = Number(fs.readFileSync(countPath, 'utf8')) + 1;",
              "fs.writeFileSync(countPath, String(count));",
              "fs.writeFileSync(path.join(__dirname, 'payload-' + count + '.pid'), String(process.pid));",
              "if (count === 1) {",
              "  const timer = setInterval(() => {",
              "    if (fs.existsSync(path.join(__dirname, 'release-first'))) {",
              "      clearInterval(timer);",
              "      console.log('on-exit payload ' + count);",
              "    }",
              "  }, 25);",
              "} else { console.log('on-exit payload ' + count); }",
            ].join("\n"),
          ),
        ]);
        const onExit = await cliJson<CronJob>(instance, [
          "cron",
          "add",
          "--name",
          "on-exit-rearm",
          "--agent",
          "probe",
          "--session",
          "isolated",
          "--no-deliver",
          "--on-exit",
          "node watch.cjs",
          "--on-exit-cwd",
          onExitDir,
          "--command-argv",
          JSON.stringify([process.execPath, path.join(onExitDir, "payload.cjs")]),
          "--timeout-seconds",
          "60",
        ]);
        try {
          const firstPid = await waitForPidFile(path.join(onExitDir, "payload-1.pid"), 30_000);
          expect(isProcessAlive(firstPid)).toBe(true);
          expect(await cliJson(instance, ["cron", "get", onExit.id])).toMatchObject({
            enabled: false,
          });
          await cliJson(instance, ["cron", "enable", onExit.id]);
          const replacementPid = await waitForPidFile(path.join(onExitDir, "watch-2.pid"), 30_000);
          await waitForDead(replacementPid, 10_000);
          expect(
            isProcessAlive(firstPid),
            "replacement watch must exit before the first payload",
          ).toBe(true);
          expect(await fs.readFile(payloadCountPath, "utf8")).toBe("1");
          expect(await cliJson(instance, ["cron", "runs", onExit.id])).toMatchObject({
            entries: [],
          });
          expect(await cliJson(instance, ["cron", "get", onExit.id])).toMatchObject({
            enabled: true,
          });

          await fs.writeFile(releasePath, "released");
          const secondPid = await waitForPidFile(path.join(onExitDir, "payload-2.pid"), 30_000);
          await Promise.all([waitForDead(firstPid, 10_000), waitForDead(secondPid, 10_000)]);
          let completedRuns: CronRunLogEntry[] = [];
          const completionDeadline = Date.now() + 30_000;
          do {
            const history = await cliJson<{ entries: CronRunLogEntry[] }>(instance, [
              "cron",
              "runs",
              onExit.id,
            ]);
            completedRuns = history.entries;
            if (completedRuns.length >= 2) {
              break;
            }
            await delay(100);
          } while (Date.now() < completionDeadline);
          expect(completedRuns).toHaveLength(2);
          expect(new Set(completedRuns.map((run) => run.summary))).toEqual(
            new Set(["on-exit payload 1", "on-exit payload 2"]),
          );
          for (const run of completedRuns) {
            expect(run).toMatchObject({ status: "ok", completionStatus: "succeeded" });
          }
          expect(new Set(completedRuns.map((run) => run.runId)).size).toBe(2);
          const settled = await waitForJob(
            instance,
            onExit.id,
            (job) => !job.enabled && job.state.runningAtMs === undefined,
          );
          expect(settled.state.lastRunStatus).toBe("ok");
          expect(await fs.readFile(payloadCountPath, "utf8")).toBe("2");
          expect(await fs.readFile(path.join(onExitDir, "watch-count"), "utf8")).toBe("2");
          await cliJson(instance, ["cron", "rm", onExit.id]);
          logLiveProgress(
            "cron scheduler: early replacement exit waited for the previous payload and fired exactly once",
          );
        } finally {
          await fs.writeFile(releasePath, "released");
        }

        const declaration = {
          name: "declaration-recovery",
          declarationKey: "probe:declaration-recovery",
          agentId: "probe",
          enabled: true,
          schedule: { kind: "every", everyMs: 86_400_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: {
            kind: "command",
            argv: [process.execPath, "-e", "process.exit(1)"],
            toolsAllow: [],
          },
          delivery: { mode: "none" },
          failureAlert: false,
        };
        const declare = () =>
          cliJson<{ job: CronJob; updated?: boolean }>(instance, [
            "gateway",
            "call",
            "cron.add",
            "--params",
            JSON.stringify(declaration),
          ]);
        const { job } = await declare();
        for (let cycle = 0; cycle < 2; cycle += 1) {
          // Public state repair places the job one scheduled failure before automatic disabling.
          await cliJson(instance, [
            "gateway",
            "call",
            "cron.update",
            "--params",
            JSON.stringify({
              id: job.id,
              patch: {
                state: {
                  consecutiveErrors: 9,
                  lastRunAtMs: Date.now() - 2 * 60 * 60_000,
                  lastDurationMs: 0,
                  nextRunAtMs: Date.now() + 1000,
                },
              },
            }),
          ]);
          const disabled = await waitForJob(instance, job.id, (saved) => !saved.enabled);
          expect(disabled).toMatchObject({
            enabled: false,
            state: { consecutiveErrors: 10, autoDisabled: { reason: "consecutive-failures" } },
          });
          if (cycle === 0) {
            const recovered = await declare();
            expect(recovered).toMatchObject({ updated: true, job: { id: job.id, enabled: true } });
            expect(recovered.job.state.consecutiveErrors).toBe(0);
            expect(recovered.job.state.autoDisabled).toBeUndefined();
            expect(await declare()).toMatchObject({ updated: false, job: { id: job.id } });
          }
        }
        expect(await cliJson(instance, ["cron", "runs", job.id])).toMatchObject({
          entries: [
            { status: "error", completionStatus: "failed" },
            { status: "error", completionStatus: "failed" },
          ],
        });
        await cliJson(instance, ["cron", "rm", job.id]);
        logLiveProgress(
          "cron scheduler: explicit declaration recovery cleared failures and allowed a second automatic disable",
        );
      },
      () => instance.cleanup(),
    );
  }, 300_000);
});
