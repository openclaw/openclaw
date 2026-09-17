import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { cronOwnerHardeningEntrypoints } from "../../cron/owner-hardening-runtime.test-support.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { triageTestRuntimeEntrypoints } from "../../infra/triage-runtime.test-support.js";
import {
  nativeFreeBsdRoot,
  withFreeBsdRootFixture,
} from "../../infra/update-freebsd-root-ownership.test-support.js";
import { getUpdateRun, type createUpdateRun } from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";

const sourceImportArgs = resolveRuntimeWorkerUrl(
  updateExecutorNativeEntrypoints.executor,
).pathname.endsWith(".ts")
  ? ["--import", path.resolve("scripts/tsx.mjs")]
  : [];

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
it.skipIf(process.platform === "win32").each([
  { signal: "SIGINT", mode: "fresh" },
  { signal: "SIGTERM", mode: "fresh" },
  { signal: "SIGINT", mode: "inherited" },
  { signal: "SIGINT", mode: "handoff" },
  { signal: "SIGINT", mode: "pending" },
  { signal: "SIGINT", mode: "activating" },
  { signal: "SIGINT", mode: "lost" },
  { signal: "SIGINT", mode: "missing" },
  { signal: "SIGINT", mode: "completed" },
  { signal: "SIGINT", mode: "no-owner" },
] as const)(
  "settles only the local pre-activation diagnostic under its real executor: $signal/$mode",
  ({ signal, mode }) =>
    nativeFreeBsdRoot
      ? withFreeBsdRootFixture(({ home }) => assertOwnedSignal(home, signal, mode))
      : assertOwnedSignal(dirs.make("update-owned-signal-"), signal, mode),
  60000,
);

it.skipIf(!nativeFreeBsdRoot).each([
  { signal: "SIGINT", mode: "root-pending" },
  { signal: "SIGTERM", mode: "root-pending" },
  { signal: "SIGINT", mode: "root-rejected" },
  { signal: "SIGTERM", mode: "root-rejected" },
] as const)(
  "preserves pending history after native ownership refusal: $signal/$mode",
  ({ signal, mode }) => withFreeBsdRootFixture(({ home }) => assertOwnedSignal(home, signal, mode)),
  60000,
);

async function assertOwnedSignal(
  root: string,
  signal: NodeJS.Signals,
  mode: string,
): Promise<void> {
  const script = path.join(root, "signal.mjs");
  fs.writeFileSync(
    script,
    `
    import fs from 'node:fs';
    import { createUpdateRun, finishUpdateRun, getUpdateRun, recordUpdateRunPhase } from ${JSON.stringify(resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.updateRunLedger).href)};
    import { createRetainedUpdateRecovery } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.retainedRecovery).href)};
    import { closeOpenClawStateDatabaseForTest } from ${JSON.stringify(resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.stateDatabase).href)};
    import { admitUpdateCommandRun, withUpdatePreviewSignals } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.commandRun).href)};
    import { withUpdateCommandExecutor } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor).href)};
    const root = ${JSON.stringify(root)};
    const mode = ${JSON.stringify(mode)};
    const opts = { restart: false };
    if (mode === 'inherited') process.env.OPENCLAW_UPDATE_RUN_ID = createUpdateRun({trigger:'cli'}).runId;
    const run = await admitUpdateCommandRun({opts, root});
    await withUpdatePreviewSignals({...opts, run}, async () => {
      const sibling = createUpdateRun({trigger:'cli'});
      const hold = async () => {
        recordUpdateRunPhase(run.runId, 'validating');
        if (mode === 'handoff') process.env.OPENCLAW_UPDATE_RUN_HANDOFF = '1';
        if (mode === 'activating') recordUpdateRunPhase(run.runId, 'activating');
        if (mode === 'completed') finishUpdateRun(run.runId, {status:'skipped',reason:'already-current'});
        if (mode === 'pending' || mode === 'missing') {
          const from = {root,nodePath:process.execPath,version:'1.0.0',buildId:null};
          createRetainedUpdateRecovery({runId:run.runId,from,to:{...from,version:'2.0.0'}},{env:run.env});
        }
        const expected = getUpdateRun(run.runId);
        if (mode === 'missing') {
          closeOpenClawStateDatabaseForTest();
          fs.mkdirSync(root + '/state/.openclaw-restore-00000000-0000-4000-8000-000000000001-0');
          fs.renameSync(root + '/state/openclaw.sqlite',root + '/state/.openclaw-restore-00000000-0000-4000-8000-000000000001-0/displaced');
        }
        if (mode === 'root-pending') {
          if (!run.freebsdRootAdmission) throw new Error('native admission missing');
          const entered = Promise.withResolvers();
          const original = fs.promises.lstat;
          // Pause the next existing filesystem probe only after real initial admission.
          fs.promises.lstat = (...args) => {
            fs.promises.lstat = original;
            entered.resolve();
            return new Promise(() => {});
          };
          void run.freebsdRootAdmission.revalidate({roots:[root],env:run.env},run.executorFence.assertCurrent).catch(() => {});
          await entered.promise;
          if (run.freebsdRootAdmission.canWrite) throw new Error('pending inspection admitted writes');
        }
        if (mode === 'root-rejected') {
          if (!run.freebsdRootAdmission) throw new Error('native admission missing');
          fs.chmodSync(root,0o777);
          let rejected = false;
          try {
            await run.freebsdRootAdmission.revalidate({roots:[root],env:run.env},run.executorFence.assertCurrent);
          } catch (error) {
            if (error.reason !== 'freebsd-update-ownership') throw error;
            rejected = true;
          } finally {
            fs.chmodSync(root,0o700);
          }
          if (!rejected || run.freebsdRootAdmission.canWrite) throw new Error('failed inspection admitted writes');
        }
        process.send({runId:run.runId,expected,sibling});
        await new Promise(() => setInterval(() => {},1000));
      };
      if (mode === 'lost') {
        await withUpdateCommandExecutor(run.runId, async (executor) => {run.executorFence = await executor.enter(root);});
        await hold();
      } else if (mode === 'no-owner') {
        await hold();
      } else {
        await withUpdateCommandExecutor(run.runId, async (executor) => {run.executorFence = await executor.enter(root);await hold();});
      }
    });
  `,
  );
  const child = spawn(process.execPath, [...sourceImportArgs, script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_SUPERVISOR_MODE: "external",
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
      OPENCLAW_UPDATE_POST_CORE: undefined,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = once(child, "close");
  try {
    const message = await Promise.race([
      once(child, "message").then(
        ([payload]) =>
          payload as {
            runId: string;
            expected: ReturnType<typeof getUpdateRun>;
            sibling: ReturnType<typeof createUpdateRun>;
          },
      ),
      closed.then(() => {
        throw new Error(`Update process exited before ready: ${stderr}`);
      }),
    ]);
    expect(child.kill(signal)).toBe(true);
    const [code, exitSignal] = await closed;
    if (mode === "root-pending" || mode === "root-rejected" || code !== null) {
      expect(code).toBe(signal === "SIGINT" ? 130 : 143);
      expect(exitSignal).toBeNull();
    } else {
      expect(exitSignal).toBe(signal);
    }
    const options =
      mode === "missing"
        ? {
            path: path.join(
              root,
              "state",
              ".openclaw-restore-00000000-0000-4000-8000-000000000001-0",
              "displaced",
            ),
          }
        : { env: { OPENCLAW_STATE_DIR: root } };
    const actual = getUpdateRun(message.runId, options);
    if (mode === "fresh") {
      expect(actual).toMatchObject({
        status: "failed",
        phase: "finished",
        reason: "interrupted",
      });
      expect(actual?.steps.some((step) => step.status === "in_progress")).toBe(false);
    } else {
      expect(actual).toEqual(message.expected);
    }
    expect(getUpdateRun(message.sibling.runId, options)).toEqual(message.sibling);
    if (mode === "root-pending" || mode === "root-rejected") {
      expect(stderr).toContain(
        "Update interruption could not be recorded; history remains pending.",
      );
    }
    if (mode === "missing") {
      for (const suffix of ["", "-wal", "-shm"]) {
        expect(fs.existsSync(path.join(root, "state", `openclaw.sqlite${suffix}`))).toBe(false);
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
  }
}
