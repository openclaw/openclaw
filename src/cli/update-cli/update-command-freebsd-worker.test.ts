import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createConfigIO } from "../../config/io.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createFreeBsdUpdateWriteAdmission } from "../../infra/update-freebsd-write-admission.js";
import { nativeFreeBsd, withFreeBsdFixture } from "../../infra/update-freebsd.test-support.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import * as childCommands from "../../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { admitUpdateCommandLedger } from "./update-command-ledger.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";

afterEach(() => vi.restoreAllMocks());

async function databaseFamily(env: NodeJS.ProcessEnv) {
  const file = resolveOpenClawStateSqlitePath(env);
  return await Promise.all(
    ["", "-wal", "-shm", "-journal"].map(
      async (suffix) =>
        await fs.readFile(file + suffix).catch((error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT")) {
            return null;
          }
          throw error;
        }),
    ),
  );
}

it.skipIf(!nativeFreeBsd).each(["api origin", "campaign origin"])(
  "the real finalizer refuses %s before adopting or replaying history",
  async (selector) => {
    await withFreeBsdFixture(async ({ home, env }) => {
      // Authenticate the actual child before its unchanged origin policy refuses
      // adoption and buffered writes.
      const root = process.cwd();
      const admission = createFreeBsdUpdateWriteAdmission();
      await admission?.revalidate(() => {});
      expect(admission).toBeDefined();
      const created = createUpdateRun(
        {
          trigger:
            selector === "api origin" ? "api" : selector === "campaign origin" ? "campaign" : "cli",
        },
        { env },
      );
      const configSnapshot = await createConfigIO({
        env,
        pluginValidation: "skip",
      }).readConfigFileSnapshot();
      closeOpenClawStateDatabaseForTest();
      const original = await databaseFamily(env);
      const control = path.join(home, "executor-control");
      await fs.mkdir(control, { mode: 0o700 });
      vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      const nativeCommand = childCommands.runUtf8CommandWithTimeout;
      const finalizerWorker = path.join(
        root,
        "dist",
        runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
      );
      const receipts: Awaited<ReturnType<typeof nativeCommand>>[] = [];
      vi.spyOn(childCommands, "runUtf8CommandWithTimeout").mockImplementation(
        async (argv, options) => {
          const child = await nativeCommand(argv, options);
          // Metadata probes share this executor but do not carry a finalizer envelope.
          if (argv.length === 2 && argv[0] === process.execPath && argv[1] === finalizerWorker) {
            expect(typeof options).toBe("object");
            if (typeof options !== "object" || typeof options.input !== "string") {
              throw new Error("Candidate continuation input is missing.");
            }
            expect(JSON.parse(options.input).params.opts.run).not.toHaveProperty(
              "freebsdWriteAdmission",
            );
            expect(JSON.parse(options.input).params.opts.run).not.toHaveProperty("ledgerAdmission");
            receipts.push(child);
          }
          return child;
        },
      );
      await withUpdateCommandExecutor(created.runId, async (executor) => {
        const executorFence = await executor.enter(root);
        const run = { runId: created.runId, env, executorFence, freebsdWriteAdmission: admission };
        admitUpdateCommandLedger(run);
        await expect(
          continueMigratedUpdateInFreshProcess(
            {
              mutationStarted: true,
              result: {
                status: "error",
                reason: "doctor-failed",
                mode: "npm",
                root,
                steps: [],
                durationMs: 0,
              },
              root,
              installKindChanged: false,
              configSnapshot,
              requestedChannel: null,
              storedChannel: "stable",
              channel: "stable",
              downgradeRisk: false,
              shouldRestart: true,
              opts: {
                json: true,
                restart: true,
                run,
              },
              ownedManagedUpdateEnv: env,
              controlPlaneUpdateSentinelMeta: null,
              preUpdatePluginInstallRecords: {},
              startedAt: Date.now(),
              packageUpdateNodeRunner: process.execPath,
              updateStepTimeoutMs: 30_000,
              rollbackBlockedReason: "state-migrated-no-rollback",
            },
            [{ step: "parent buffered receipt", status: "completed" }],
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
        executorFence.assertCurrent();
      });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ code: 1, termination: "exit", cleanup: "normal" });
      expect(receipts[0]?.stderr).toContain(
        "FreeBSD foreground continuation requires the same existing manual CLI update run",
      );
      expect(await databaseFamily(env)).toEqual(original);
      expect(getUpdateRun(created.runId, { env })).toEqual(created);
    });
  },
  60_000,
);

it.skipIf(!nativeFreeBsd).each([
  { restart: undefined, timeout: undefined },
  { restart: true, timeout: undefined },
  { restart: false, timeout: undefined },
  { restart: undefined, timeout: "60" },
])(
  "the real finalizer completes its owning user's run with restart=$restart, timeout=$timeout",
  async ({ restart, timeout }) => {
    await withFreeBsdFixture(async ({ home, env }) => {
      const root = process.cwd();
      const workspace = path.join(home, "workspace");
      await fs.mkdir(workspace, { mode: 0o700 });
      const config = {
        gateway: { mode: "local", auth: { mode: "token", token: "fixture-finalizer-token" } },
        agents: { defaults: { workspace } },
        plugins: { enabled: false },
      };
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config), { mode: 0o600 });
      const admission = createFreeBsdUpdateWriteAdmission();
      await admission?.revalidate(() => {});
      expect(admission).toBeDefined();
      const retained = createUpdateRun({ trigger: "cli" }, { env });
      finishUpdateRun(retained.runId, { status: "succeeded" }, { env });
      const previous = getUpdateRun(retained.runId, { env });
      const created = createUpdateRun({ trigger: "cli" }, { env });
      const configIO = createConfigIO({ env, pluginValidation: "skip" });
      const configSnapshot = await configIO.readConfigFileSnapshot();
      expect(configSnapshot.valid).toBe(true);
      closeOpenClawStateDatabaseForTest();
      const control = path.join(home, "executor-control");
      await fs.mkdir(control, { mode: 0o700 });
      vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      const nativeCommand = childCommands.runUtf8CommandWithTimeout;
      const finalizerWorker = path.join(
        root,
        "dist",
        runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
      );
      const receipts: Awaited<ReturnType<typeof nativeCommand>>[] = [];
      vi.spyOn(childCommands, "runUtf8CommandWithTimeout").mockImplementation(
        async (argv, options) => {
          const child = await nativeCommand(argv, options);
          // Metadata probes share this executor but do not carry a finalizer envelope.
          if (argv.length === 2 && argv[0] === process.execPath && argv[1] === finalizerWorker) {
            if (typeof options !== "object" || typeof options.input !== "string") {
              throw new Error("Candidate continuation input is missing.");
            }
            expect(JSON.parse(options.input).params.opts.run).not.toHaveProperty(
              "freebsdWriteAdmission",
            );
            expect(JSON.parse(options.input).params.opts.run).not.toHaveProperty("ledgerAdmission");
            receipts.push(child);
          }
          return child;
        },
      );
      const bufferedStep = {
        step: "parent buffered receipt",
        status: "completed" as const,
        startedAtMs: Date.now(),
        endedAtMs: Date.now(),
        detail: "Completed before candidate continuation.",
      };
      await withUpdateCommandExecutor(created.runId, async (executor) => {
        const executorFence = await executor.enter(root);
        const run = { runId: created.runId, env, executorFence, freebsdWriteAdmission: admission };
        admitUpdateCommandLedger(run);
        // A successful helper return requires the actual candidate worker's
        // terminal run identity, delegated authority, and settled child receipt.
        const completed = await continueMigratedUpdateInFreshProcess(
          {
            mutationStarted: true,
            result: { status: "ok", mode: "npm", root, steps: [], durationMs: 0 },
            root,
            installKindChanged: false,
            configSnapshot,
            requestedChannel: null,
            storedChannel: "stable",
            channel: "stable",
            downgradeRisk: false,
            shouldRestart: restart !== false,
            opts: {
              json: true,
              restart,
              timeout,
              run,
            },
            ownedManagedUpdateEnv: env,
            controlPlaneUpdateSentinelMeta: null,
            preUpdatePluginInstallRecords: {},
            startedAt: Date.now(),
            packageUpdateNodeRunner: process.execPath,
            updateStepTimeoutMs: 30_000,
            rollbackBlockedReason: "state-migrated-no-rollback",
          },
          [bufferedStep],
        );
        expect(completed).toMatchObject({
          exitCode: 0,
          result: { status: "ok", runId: created.runId },
        });
        executorFence.assertCurrent();
      });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ code: 0, termination: "exit", cleanup: "normal" });
      const finished = getUpdateRun(created.runId, { env });
      expect(finished).toMatchObject({
        runId: created.runId,
        status: "succeeded",
        phase: "finished",
        finishedAtMs: expect.any(Number),
      });
      expect(finished?.steps.filter((step) => step.step === bufferedStep.step)).toEqual([
        bufferedStep,
      ]);
      expect(finished?.steps).toContainEqual(
        expect.objectContaining({ step: "driver:adopted", status: "completed" }),
      );
      expect(getUpdateRun(retained.runId, { env })).toEqual(previous);
      const after = await configIO.readConfigFileSnapshot();
      expect(after.valid).toBe(true);
      expect(after.sourceConfig).toMatchObject(config);
      expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
    });
  },
  60_000,
);
