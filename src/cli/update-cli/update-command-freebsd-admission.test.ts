import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readRestartSentinelReadOnly, writeRestartSentinel } from "../../infra/restart-sentinel.js";
import { admitFreeBsdUpdateRootOwnership } from "../../infra/update-freebsd-root-ownership.js";
import {
  nativeFreeBsdRoot,
  withFreeBsdRootFixture,
} from "../../infra/update-freebsd-root-ownership.test-support.js";
import { buildUpdateRestartSentinelPayload } from "../../infra/update-restart-sentinel-payload.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import * as exec from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  markControlPlaneUpdateRestartSentinelFailureBestEffort,
  writeControlPlaneUpdateRestartSentinelBestEffort,
} from "./update-command-result.js";
import {
  completeUpdateCommandRun,
  createUpdateRunProgress,
  failUpdateCommandRun,
} from "./update-command-run.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.skipIf(!nativeFreeBsdRoot)("native FreeBSD update admission and history", () => {
  it.each(["write", "mark"] as const)(
    "routes admitted sentinel %s to selected state and refuses pending or revoked admission",
    async (operation) => {
      await withFreeBsdRootFixture(async ({ home, root, env }) => {
        const callerEnv = {
          ...env,
          OPENCLAW_STATE_DIR: path.join(home, "caller-state"),
          OPENCLAW_CONFIG_PATH: path.join(home, "caller-openclaw.json"),
        };
        for (const [key, value] of Object.entries(callerEnv)) {
          vi.stubEnv(key, value);
        }
        const run: NonNullable<UpdateCommandOptions["run"]> = {
          runId: createUpdateRun(
            { trigger: "api", origin: { sessionKey: "agent:ops:main" } },
            { env },
          ).runId,
          env,
        };
        const meta = { runId: run.runId, handoffId: "native-admission" };
        const pending = buildUpdateRestartSentinelPayload({
          result: { status: "skipped", mode: "npm", steps: [], durationMs: 1 },
          meta: { ...meta, continuationMessage: "resume after restart" },
        });
        // Matching owner metadata in both stores makes an accidental caller write visible.
        await writeRestartSentinel(pending, callerEnv);
        await writeRestartSentinel(pending, env);
        const input = { roots: [root], env };
        const admission = await admitFreeBsdUpdateRootOwnership(input);
        expect(admission).toBeDefined();
        run.freebsdRootAdmission = admission!;
        const callerBefore = await readRestartSentinelReadOnly(callerEnv);
        const publish = () =>
          operation === "write"
            ? writeControlPlaneUpdateRestartSentinelBestEffort({
                meta,
                result: { status: "ok", mode: "npm", steps: [], durationMs: 1 },
                jsonMode: true,
                env,
                run,
              })
            : markControlPlaneUpdateRestartSentinelFailureBestEffort({
                meta,
                reason: "native-admission-fixture",
                jsonMode: true,
                env,
                run,
              });
        await publish();
        const selectedBefore = await readRestartSentinelReadOnly(env);
        expect(selectedBefore?.payload).toMatchObject({
          kind: "update",
          status: operation === "write" ? "ok" : "error",
          stats: { runId: run.runId, handoffId: meta.handoffId },
        });
        expect(await readRestartSentinelReadOnly(callerEnv)).toEqual(callerBefore);
        const historyBefore = getUpdateRun(run.runId, { env });
        const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
        const entered = createDeferred();
        const resume = createDeferred();
        const nativeProbe = exec.runCommandBuffered;
        vi.spyOn(exec, "runCommandBuffered").mockImplementationOnce(async (...args) => {
          entered.resolve();
          await resume.promise;
          return await nativeProbe(...args);
        });
        const recheck = admission!
          .revalidate(input, () => {})
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        try {
          await entered.promise;
          expect(admission!.canWrite).toBe(false);
          expect(admission!.failure).toBeUndefined();
          await expect(publish()).rejects.toMatchObject({ reason: "freebsd-update-ownership" });
          expect(await readRestartSentinelReadOnly(env)).toEqual(selectedBefore);
          expect(await readRestartSentinelReadOnly(callerEnv)).toEqual(callerBefore);
          await fs.chmod(root, 0o777);
        } finally {
          resume.resolve();
          await recheck;
        }
        const failure = await recheck;
        expect(failure).toBeInstanceOf(Error);
        expect(admission!.failure).toBe(failure);
        await expect(publish()).rejects.toBe(failure);
        expect(errors).not.toHaveBeenCalled();
        expect(await readRestartSentinelReadOnly(env)).toEqual(selectedBefore);
        expect(await readRestartSentinelReadOnly(callerEnv)).toEqual(callerBefore);
        expect(getUpdateRun(run.runId, { env })).toEqual(historyBefore);
        expect(getUpdateRun(run.runId, { env: callerEnv })).toBeUndefined();
      });
    },
    30_000,
  );

  it.each(["admitted", "permissions changed", "overlapping recheck", "idle fence lost"])(
    "keeps selected history unavailable during inspection: %s",
    async (outcome) => {
      await withFreeBsdRootFixture(async ({ root, env }) => {
        const input = { roots: [root], env };
        const admission = await admitFreeBsdUpdateRootOwnership(input);
        expect(admission).toBeDefined();
        const run = {
          runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
          env,
          freebsdRootAdmission: admission!,
        };
        const original = getUpdateRun(run.runId, { env });
        const displayed = { onStepStart: vi.fn(), onStepComplete: vi.fn() };
        const progress = createUpdateRunProgress(run, displayed);
        const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
        const complete = () =>
          completeUpdateCommandRun(
            { status: "ok", mode: "npm", root, steps: [], durationMs: 1 },
            run,
          );
        const report = () => {
          progress.onHeartbeat?.();
          progress.onStepStart?.({
            name: "candidate validation",
            command: "fixture validation",
            index: 0,
            total: 1,
          });
          progress.onStepComplete?.({
            name: "candidate validation",
            command: "fixture validation",
            index: 0,
            total: 1,
            durationMs: 1,
            exitCode: 0,
          });
          progress.flushLedgerWrites();
          failUpdateCommandRun(new Error("late diagnostic"), run);
          expect(complete()).toMatchObject({ status: "error", reason: "freebsd-update-ownership" });
        };
        const entered = createDeferred();
        const resume = createDeferred();
        const nativeProbe = exec.runCommandBuffered;
        vi.spyOn(exec, "runCommandBuffered").mockImplementationOnce(async (...args) => {
          entered.resolve();
          await resume.promise;
          return await nativeProbe(...args);
        });
        let idle = true;
        const assertIdle = () => {
          if (!idle) {
            throw new Error("fixture executor delegated");
          }
        };
        const recheck = admission!.revalidate(input, assertIdle);
        // Install the rejection observer before manipulating the paused owner.
        const settled = recheck.then(
          () => undefined,
          (error: unknown) => error,
        );
        let firstFailure: Error | undefined;
        try {
          await entered.promise;
          expect(() => admission!.assertCurrent()).toThrow();
          expect(admission!.failure).toBeUndefined();
          expect(report).not.toThrow();
          expect(getUpdateRun(run.runId, { env })).toEqual(original);
          expect(displayed.onStepStart).toHaveBeenCalledOnce();
          expect(displayed.onStepComplete).toHaveBeenCalledOnce();
          expect(errors).toHaveBeenCalledWith(expect.stringContaining("history remains pending"));
          if (outcome === "permissions changed") {
            await fs.chmod(root, 0o777);
          } else if (outcome === "overlapping recheck") {
            await expect(admission!.revalidate(input, assertIdle)).rejects.toMatchObject({
              reason: "freebsd-update-ownership",
            });
            firstFailure = admission!.failure;
          } else if (outcome === "idle fence lost") {
            idle = false;
          }
        } finally {
          resume.resolve();
          await settled;
        }
        const failure = await settled;
        if (outcome === "admitted") {
          expect(failure).toBeUndefined();
          expect(admission!.failure).toBeUndefined();
          expect(() => admission!.assertCurrent()).not.toThrow();
          progress.flushLedgerWrites();
          expect(getUpdateRun(run.runId, { env })?.steps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ step: "candidate validation", status: "completed" }),
            ]),
          );
          expect(complete().status).toBe("ok");
          expect(getUpdateRun(run.runId, { env })?.status).toBe("succeeded");
        } else {
          expect(failure).toBeInstanceOf(Error);
          firstFailure ??= admission!.failure;
          expect(firstFailure).toBeInstanceOf(Error);
          expect(failure).toBe(firstFailure);
          expect(admission!.failure).toBe(firstFailure);
          await fs.chmod(root, 0o700);
          idle = true;
          await expect(admission!.revalidate(input, assertIdle)).rejects.toBe(firstFailure);
          expect(report).not.toThrow();
          expect(getUpdateRun(run.runId, { env })).toEqual(original);
        }
      });
    },
    30_000,
  );
});

it.skipIf(process.platform !== "linux")(
  "retains ordinary Linux progress and completion",
  async () => {
    await withTestDir({ prefix: "update-admission-linux-" }, async (root) => {
      const env = { OPENCLAW_STATE_DIR: root };
      const admission = await admitFreeBsdUpdateRootOwnership({ roots: [root], env });
      expect(admission).toBeUndefined();
      const run = {
        runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
        env,
        freebsdRootAdmission: admission,
      };
      const progress = createUpdateRunProgress(run, {});
      progress.onStepStart?.({
        name: "candidate validation",
        command: "fixture validation",
        index: 0,
        total: 1,
      });
      expect(getUpdateRun(run.runId, { env })?.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ step: "candidate validation", status: "in_progress" }),
        ]),
      );
      expect(
        completeUpdateCommandRun({ status: "ok", mode: "npm", steps: [], durationMs: 1 }, run)
          .status,
      ).toBe("ok");
      expect(getUpdateRun(run.runId, { env })?.status).toBe("succeeded");
    });
  },
);
