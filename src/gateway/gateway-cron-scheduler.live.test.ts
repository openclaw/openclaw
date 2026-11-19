import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type {
  CronScratchGetResult,
  CronScratchSetResult,
} from "../../packages/gateway-protocol/src/schema/cron.types.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { isLiveTestEnabled, logLiveProgress } from "../agents/live-test-helpers.js";
import type { CronRunLogEntry } from "../cron/run-log-types.js";
import type { CronJob } from "../cron/types.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../secrets/provider-env-vars.js";

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
  it("preserves trigger intervals, stream matches, timeout output, and declaration recovery", async () => {
    const instance = await createOpenClawTestInstance({
      name: "cron-scheduler",
      env: {
        ...Object.fromEntries(
          listKnownProviderAuthEnvVarNamesCore().map((name) => [name, undefined]),
        ),
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
        await cliJson(instance, ["cron", "disable", watcher.id]);
        const quiescent = await waitForJob(
          instance,
          watcher.id,
          (job) => !job.enabled && job.state.runningAtMs === undefined,
        );
        const scratchText = "private café notes\nretained across restart";
        expect(
          await cliJson<CronScratchSetResult>(instance, [
            "cron",
            "scratch",
            watcher.id,
            "--set",
            scratchText,
            "--expected-revision",
            "0",
          ]),
        ).toMatchObject({ ok: true, currentRevision: 1, scratch: { content: scratchText } });
        await instance.stopGateway();
        await instance.startGateway();
        const restored = await cliJson<CronJob>(instance, ["cron", "get", watcher.id]);
        expect(restored.enabled).toBe(false);
        expect(restored.state).toEqual(quiescent.state);
        expect(
          await cliJson<CronScratchGetResult>(instance, ["cron", "scratch", watcher.id]),
        ).toMatchObject({ currentRevision: 1, scratch: { content: scratchText } });
        expect(
          await cliJson<CronScratchSetResult>(instance, [
            "cron",
            "scratch",
            watcher.id,
            "--unset",
            "--expected-revision",
            "1",
          ]),
        ).toEqual({ ok: true, scratch: null, currentRevision: 2, maxBytes: 262_144 });
        const staleScratch = await instance.cli([
          "cron",
          "scratch",
          watcher.id,
          "--set",
          "stale resurrection",
          "--expected-revision",
          "1",
          "--url",
          instance.url,
          "--token",
          instance.gatewayToken,
          "--json",
        ]);
        expect(staleScratch.code).toBe(1);
        expect(staleScratch.stderr).toContain("cron scratch changed concurrently");
        const clearedScratch = await cliJson<CronScratchGetResult>(instance, [
          "cron",
          "scratch",
          watcher.id,
        ]);
        expect(clearedScratch.currentRevision).toBe(2);
        expect(clearedScratch.scratch).toBeNull();
        await cliJson(instance, ["cron", "rm", watcher.id]);
        logLiveProgress(
          "cron scheduler: quiet condition kept its 30-second floor; disabled trigger state and scratch survived restart",
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
