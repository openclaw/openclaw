import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
  type UpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import * as processRunner from "../../process/exec.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { waitForPidToExit } from "../../test-utils/process-tree.js";
import type { UpdateCommandOptions } from "./shared.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { runPackageUpdateDoctor } from "./update-command-package.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let serviceRoot: string;
let configPath: string;
let received: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = fs.realpathSync(dirs.make("doctor-delegation-"));
  serviceRoot = path.join(root, "service-A");
  configPath = path.join(root, "state", "openclaw.json");
  received = path.join(root, "received.json");
  for (const dir of [
    serviceRoot,
    path.dirname(configPath),
    path.join(root, "dist"),
    path.join(root, "tmp"),
  ]) {
    fs.mkdirSync(dir, { mode: 0o700 });
  }
  fs.writeFileSync(configPath, "{}\n");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.99" }),
  );
  fs.writeFileSync(path.join(root, "dist", "index.js"), "");
  env = {
    HOME: root,
    OPENCLAW_STATE_DIR: path.dirname(configPath),
    OPENCLAW_CONFIG_PATH: configPath,
  };
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(path.join(root, "tmp"));
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "resumes the parent after its bound Doctor (shared schema migrated=%s)",
  async (migrated) => {
    const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
    closeOpenClawStateDatabaseForTest();
    const runUtf8 = processRunner.runUtf8CommandWithTimeout;
    let spawned = false;
    await withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root, { serviceRoot });
      const opts: UpdateCommandOptions = { run: { runId, env, executorFence: fence } };
      const guards = createUpdateCommandExecutionGuards(opts, root);
      vi.spyOn(processRunner, "runUtf8CommandWithTimeout").mockImplementation(
        async (_argv, options) => {
          assert(typeof options !== "number", "Doctor supplies input-admission options");
          // Only the Doctor program is substituted. Spawn, PID binding, input ordering,
          // native executor custody, and process-tree settlement are the production owners.
          expect(() => fence.assertCurrent()).toThrow("The update process is still running.");
          spawned = true;
          return runUtf8(
            [
              process.execPath,
              "-e",
              `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{
              require('node:fs').writeFileSync(process.argv[1],s);
              ${migrated ? `const db=new (require('node:sqlite').DatabaseSync)(${JSON.stringify(resolveOpenClawStateSqlitePath(env))});db.exec(${JSON.stringify(`BEGIN IMMEDIATE; PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}; UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1} WHERE meta_key = 'primary'; COMMIT;`)});db.close();` : ""}
            });`,
              received,
            ],
            options,
          );
        },
      );
      const result = await runPackageUpdateDoctor({
        root,
        timeoutMs: 5000,
        progress: {},
        managedServiceEnv: env,
        getDoctorContext: () => ({
          runId,
          executorFence: fence,
          inputHash: hashConfigRaw("{}\n"),
          changes: [],
          ...guards,
        }),
      });
      expect(result).toMatchObject({ exitCode: 0 });
      expect(spawned).toBe(true);
      expect(JSON.parse(fs.readFileSync(received, "utf8"))).toMatchObject({ runId, root });
      fence.assertCurrent();
      guards.assertCurrent();
      if (migrated) {
        expect(() => loadUpdateRecovery(runId, { env })).toThrow(/newer schema version/);
      }
      expect(fs.readFileSync(configPath, "utf8")).toBe("{}\n");
    });
  },
);

it.each([
  "requester-revoked",
  "requester-replaced",
  "fence-reassigned",
  "run-reassigned",
  "recovery-pending",
  "A-revoked",
  "B-revoked",
] as const)(
  "withholds all Doctor input and settles the real child when %s before input",
  async (change) => {
    const runId = randomUUID();
    const runUtf8 = processRunner.runUtf8CommandWithTimeout;
    let childPid: number | undefined;
    let current = true;
    const requesterAuthority = {
      requester: { channel: "test", senderId: "owner" },
      isCurrent: () => current,
    };
    const work = withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root, { serviceRoot });
      const run = { runId, env, executorFence: fence, requesterAuthority };
      const opts: UpdateCommandOptions = { run };
      const guards = createUpdateCommandExecutionGuards(opts, root);
      vi.spyOn(processRunner, "runUtf8CommandWithTimeout").mockImplementation(
        async (_argv, options) => {
          assert(typeof options !== "number", "Doctor supplies input-admission options");
          expect(() => fence.assertCurrent()).toThrow("The update process is still running.");
          return runUtf8(
            [
              process.execPath,
              "-e",
              "process.stdin.on('data',x=>require('node:fs').appendFileSync(process.argv[1],x));process.stdin.resume();",
              received,
            ],
            {
              ...options,
              beforeInput(pid, spawnedArgv) {
                childPid = pid;
                if (change === "requester-revoked") {
                  current = false;
                }
                if (change === "requester-replaced") {
                  run.requesterAuthority = { ...requesterAuthority };
                }
                if (change === "fence-reassigned") {
                  run.executorFence = { assertCurrent() {} };
                }
                if (change === "run-reassigned") {
                  opts.run = { ...run };
                }
                if (change === "recovery-pending") {
                  opts.recovery = {};
                }
                if (change === "A-revoked" || change === "B-revoked") {
                  const db = new DatabaseSync(
                    path.join(root, "tmp", "managed-update-handoffs.sqlite"),
                  );
                  try {
                    db.prepare(
                      "UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?",
                    ).run("replacement", change === "A-revoked" ? serviceRoot : root);
                  } finally {
                    db.close();
                  }
                }
                options.beforeInput?.(pid, spawnedArgv);
              },
            },
          );
        },
      );
      await runPackageUpdateDoctor({
        root,
        timeoutMs: 5000,
        progress: {},
        managedServiceEnv: env,
        getDoctorContext: () => ({
          runId,
          executorFence: fence,
          inputHash: hashConfigRaw("{}\n"),
          changes: [],
          ...guards,
        }),
      });
    });
    await expect(work).rejects.toThrow();
    expect(childPid).toBeTypeOf("number");
    if (childPid !== undefined) {
      expect(await waitForPidToExit(childPid)).toBe(true);
    }
    expect(fs.existsSync(received)).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).toBe("{}\n");
  },
);

it.each([
  { exitCode: 23, revokeAfterSettlement: false },
  { exitCode: 0, revokeAfterSettlement: true },
  { exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE, revokeAfterSettlement: true },
])(
  "retains settled Doctor outcome $exitCode when requester revocation after settlement is $revokeAfterSettlement",
  async ({ exitCode, revokeAfterSettlement }) => {
    const runId = randomUUID();
    const runUtf8 = processRunner.runUtf8CommandWithTimeout;
    let childPid: number | undefined;
    let resultPath: string | undefined;
    let authorityRefusal: unknown;
    const receipt: UpdatePostInstallDoctorResult =
      exitCode === UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE
        ? createDeferredConfiguredPluginRepairDoctorResult(["Configured plugin repair deferred."])
        : { status: exitCode === 0 ? "ok" : "error" };
    receipt.configChanges = [{ kind: "migration", message: "Moved model allowlist." }];
    const steps: UpdateStepResult[] = [];
    const onStepComplete = vi.fn();
    await withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root, { serviceRoot });
      const opts: UpdateCommandOptions = {
        run: {
          runId,
          env,
          executorFence: fence,
          requesterAuthority: {
            requester: { channel: "test", senderId: "owner" },
            isCurrent: () => true,
          },
        },
      };
      const guards = createUpdateCommandExecutionGuards(opts, root);
      vi.spyOn(processRunner, "runUtf8CommandWithTimeout").mockImplementation(
        async (_argv, options) => {
          assert(typeof options !== "number", "Doctor supplies input-admission options");
          const result = await runUtf8(
            [
              process.execPath,
              "-e",
              "process.stdin.resume();process.stdin.on('end',()=>process.exit(Number(process.argv[1])));",
              String(exitCode),
            ],
            {
              ...options,
              beforeInput(pid, spawnedArgv) {
                childPid = pid;
                options.beforeInput?.(pid, spawnedArgv);
              },
            },
          );
          expect(result.cleanup).toBe("normal");
          expect(result.code).toBe(exitCode);
          expect(onStepComplete).not.toHaveBeenCalled();
          resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
          assert(resultPath);
          await writeUpdatePostInstallDoctorResult({ resultPath, result: receipt });
          if (revokeAfterSettlement) {
            assert(opts.run?.requesterAuthority);
            opts.run.requesterAuthority = { ...opts.run.requesterAuthority };
          }
          return result;
        },
      );
      const result = await runPackageUpdateDoctor({
        root,
        timeoutMs: 5000,
        progress: { onStepComplete },
        results: steps,
        managedServiceEnv: env,
        getDoctorContext: () => ({
          runId,
          executorFence: fence,
          inputHash: hashConfigRaw("{}\n"),
          changes: [],
          ...guards,
          assertCurrent: () => {
            try {
              guards.assertCurrent();
            } catch (error) {
              authorityRefusal = error;
              throw error;
            }
          },
        }),
      }).catch((cause: unknown) => cause);
      if (revokeAfterSettlement) {
        expect(result).toBeInstanceOf(UpdateRequesterRevokedError);
        expect(result).toBe(authorityRefusal);
        expect(onStepComplete).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            name: "openclaw doctor",
            exitCode,
            advisory: undefined,
            configChanges: receipt.configChanges,
            failureFacts: expect.arrayContaining([
              expect.objectContaining({ code: "requester-revoked" }),
            ]),
          }),
        );
        expect(steps).toEqual([
          expect.objectContaining({
            name: "openclaw doctor",
            exitCode,
            configChanges: receipt.configChanges,
            stderrTail: expect.stringContaining("requester-revoked"),
          }),
        ]);
        const [failedDoctor] = steps;
        assert(failedDoctor);
        expect(failedDoctor.advisory).toBeUndefined();
      } else {
        expect(result).toMatchObject({ exitCode: 23 });
        guards.assertCurrent();
      }
      expect(childPid).toBeTypeOf("number");
      if (childPid !== undefined) {
        expect(await waitForPidToExit(childPid)).toBe(true);
      }
      fence.assertCurrent();
      assert(resultPath);
      expect(fs.existsSync(resultPath)).toBe(false);
      expect(fs.readFileSync(configPath, "utf8")).toBe("{}\n");
    });
  },
);

it("preserves before-input failure after owned child cleanup without input", async () => {
  const runId = randomUUID();
  const runUtf8 = processRunner.runUtf8CommandWithTimeout;
  let childPid: number | undefined;
  const work = withUpdateCommandExecutor(runId, async (executor) => {
    const fence = await executor.enter(root, { serviceRoot });
    const opts: UpdateCommandOptions = { run: { runId, env, executorFence: fence } };
    const guards = createUpdateCommandExecutionGuards(opts, root);
    vi.spyOn(processRunner, "runUtf8CommandWithTimeout").mockImplementation(
      async (_argv, options) => {
        assert(typeof options !== "number", "Doctor supplies input-admission options");
        return runUtf8(
          [
            process.execPath,
            "-e",
            "process.stdin.on('data',x=>require('node:fs').appendFileSync(process.argv[1],x));setInterval(()=>{},1000);",
            received,
          ],
          {
            ...options,
            beforeInput(pid, spawnedArgv) {
              childPid = pid;
              options.beforeInput?.(pid, spawnedArgv);
              throw new Error("injected before-input failure after live child binding");
            },
          },
        );
      },
    );
    await runPackageUpdateDoctor({
      root,
      timeoutMs: 5000,
      progress: {},
      managedServiceEnv: env,
      getDoctorContext: () => ({
        runId,
        executorFence: fence,
        inputHash: hashConfigRaw("{}\n"),
        changes: [],
        ...guards,
      }),
    });
  });
  await expect(work).rejects.toMatchObject({
    message: "injected before-input failure after live child binding",
    cleanup: process.platform === "win32" ? "forced" : "cooperative",
  });
  expect(childPid).toBeTypeOf("number");
  if (childPid !== undefined) {
    expect(await waitForPidToExit(childPid)).toBe(true);
  }
  expect(fs.existsSync(received)).toBe(false);
  expect(fs.readFileSync(configPath, "utf8")).toBe("{}\n");
});
