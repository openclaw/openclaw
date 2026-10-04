import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
  type UpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "../../infra/update-managed-service-handoff-database.js";
import { parseManagedHandoffLeasePayload } from "../../infra/update-managed-service-handoff-schema.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { isChildProcessTreeAlive } from "../../process/child-process-tree.js";
import { settleCommandProcessGroups } from "../../process/command-process-custody.js";
import type { CommandProcessIdentity } from "../../process/command-process-custody.types.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import * as processRunner from "../../process/exec.js";
import { getProcessInstanceStartTime } from "../../shared/pid-alive.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { waitForPidToExit } from "../../test-utils/process-tree.js";
import type { UpdateCommandOptions } from "./shared.js";
import { runUpdateDoctorProcess } from "./update-command-doctor-child.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { settleUpdateDoctorMaintenance } from "./update-command-maintenance.js";
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

function doctorOptions(
  runId: string,
  executorFence: UpdateRecoveryFence,
  guards: ReturnType<typeof createUpdateCommandExecutionGuards>,
): Parameters<typeof runPackageUpdateDoctor>[0] {
  return {
    root,
    timeoutMs: 5000,
    progress: {},
    managedServiceEnv: env,
    getDoctorContext: () => ({
      runId,
      executorFence,
      inputHash: hashConfigRaw("{}\n"),
      changes: [],
      ...guards,
    }),
  };
}

function readHandoffClaims() {
  const read = createManagedHandoffLeaseDatabase(
    path.join(root, "tmp", "managed-update-handoffs.sqlite"),
  );
  return read(
    false,
    (db) =>
      executeSqliteQuerySync(db, leaseQueries(db).selectFrom("managed_update_handoffs").selectAll())
        .rows,
  );
}

function readCommandClaims() {
  return readHandoffClaims().filter((row) => {
    const payload = parseManagedHandoffLeasePayload(row.payload_json);
    return (
      /\/\.openclaw-update-child-[a-f0-9-]{36}-command$/.test(row.install_root) &&
      payload?.version === 2 &&
      payload.action.kind === "update"
    );
  });
}

function expectRetainedCommandClaims(writerPid: number, roots: string[]) {
  const claims = readCommandClaims();
  expect(claims).toHaveLength(roots.length);
  expect(claims.map((claim) => claim.install_root.split("/.openclaw-update-child-")[0])).toEqual(
    expect.arrayContaining(roots),
  );
  for (const claim of claims) {
    expect(parseManagedHandoffLeasePayload(claim.payload_json)).toMatchObject({
      version: 2,
      executor: { pid: writerPid },
      action: { kind: "update" },
    });
  }
}

it.each([
  "requester-replaced",
  "fence-reassigned",
  "recovery-pending",
  "A-revoked",
  "B-revoked",
] as const)(
  "withholds all Doctor input and settles the real child when %s before input",
  async (change) => {
    const runId = randomUUID();
    const runUtf8 = processRunner.runUtf8CommandWithTimeout;
    let childPid: number | undefined;
    const requesterAuthority = {
      requester: { channel: "test", senderId: "owner" },
      isCurrent: () => true,
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
                if (change === "requester-replaced") {
                  run.requesterAuthority = { ...requesterAuthority };
                }
                if (change === "fence-reassigned") {
                  run.executorFence = { assertCurrent() {} };
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
      await runPackageUpdateDoctor(doctorOptions(runId, fence, guards));
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
        : { status: "error" };
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
        ...doctorOptions(runId, fence, {
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
        progress: { onStepComplete },
        results: steps,
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

it("preserves before-input failure after proving the delegated grant was withheld", async () => {
  const runId = randomUUID();
  const runUtf8 = processRunner.runUtf8CommandWithTimeout;
  let childPid: number | undefined;
  const steps: UpdateStepResult[] = [];
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
    await runPackageUpdateDoctor({ ...doctorOptions(runId, fence, guards), results: steps });
  });
  const failure = await work.catch((error: unknown) => error);
  expect(hasCommandProcessCleanupError(failure)).toBe(false);
  expect(failure).toMatchObject({
    message: "injected before-input failure after live child binding",
    cleanup: process.platform === "win32" ? "forced" : "cooperative",
  });
  expect(steps.filter((step) => step.name === "doctor process settlement")).toEqual([]);
  expect(childPid).toBeTypeOf("number");
  if (childPid !== undefined) {
    expect(await waitForPidToExit(childPid)).toBe(true);
  }
  expect(fs.existsSync(received)).toBe(false);
  expect(fs.readFileSync(configPath, "utf8")).toBe("{}\n");
});

it("does not treat standalone input withholding as a delegated no-writer proof", async () => {
  const original = new Error("Standalone input refused");
  let pid: number | undefined;
  const steps: UpdateStepResult[] = [];
  const failure = await runUpdateDoctorProcess(
    { runId: randomUUID(), root, onProcessSettlement: (step) => steps.push(step) },
    [
      process.execPath,
      "-e",
      "process.stdin.on('data', x => require('node:fs').appendFileSync(process.argv[1], x)); process.stdin.resume();",
      received,
    ],
    {
      cwd: root,
      input: "must not be delivered",
      timeoutMs: 5_000,
      env: {
        ...env,
        [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: path.join(root, "standalone-result.json"),
      },
      beforeInput: (spawnedPid) => {
        pid = spawnedPid;
        throw original;
      },
    },
  ).catch((error: unknown) => error);
  assert(pid);
  expect(hasCommandProcessCleanupError(failure)).toBe(true);
  expect(failure).toMatchObject({ cause: original });
  expect(steps).toContainEqual(
    expect.objectContaining({
      name: "doctor process settlement",
      exitCode: 1,
      failureFacts: [
        expect.objectContaining({
          code: "doctor-processes-unsettled",
          message: expect.stringContaining(String(pid)),
        }),
      ],
    }),
  );
  expect(await waitForPidToExit(pid)).toBe(true);
  expect(fs.existsSync(received)).toBe(false);
  expect(fs.readFileSync(configPath, "utf8")).toBe("{}\n");
});

it.skipIf(process.platform === "win32").each([true, false])(
  "settles a CPU-bound Doctor at its deadline or records unresolved writer identity (identity=%s)",
  async (identityAvailable) => {
    const runId = randomUUID();
    const runUtf8 = processRunner.runUtf8CommandWithTimeout;
    let childPid: number | undefined;
    let writer: CommandProcessIdentity | undefined;
    const steps: UpdateStepResult[] = [];
    const reportingError = new Error("settlement progress could not be recorded");
    let reportedFailure: unknown;
    try {
      const execution = withUpdateCommandExecutor(runId, async (executor) => {
        const fence = await executor.enter(root, { serviceRoot });
        const guards = createUpdateCommandExecutionGuards(
          { run: { runId, env, executorFence: fence } },
          root,
        );
        vi.spyOn(processRunner, "runUtf8CommandWithTimeout").mockImplementation(
          async (_argv, options) => {
            assert(typeof options !== "number");
            const result = await runUtf8(busyDoctorWriterArgv(identityAvailable), {
              ...options,
              beforeInput(pid, argv) {
                childPid = pid;
                options.beforeInput?.(pid, argv);
              },
            });
            expect(result, result.stderr).toMatchObject({
              termination: "timeout",
              cleanup: "forced",
              signal: "SIGKILL",
            });
            const pid = Number(/Doctor busy (\d+)/.exec(result.stdout)?.[1]);
            assert(pid > 0, result.stderr);
            writer = { pid, startedAt: getProcessInstanceStartTime(pid) };
            return result;
          },
        );
        const step = await runPackageUpdateDoctor({
          ...doctorOptions(runId, fence, guards),
          results: steps,
          progress: {
            onStepComplete: (completedStep) => {
              if (identityAvailable || completedStep.name !== "doctor process settlement") {
                return undefined;
              }
              throw reportingError;
            },
          },
        }).catch((error: unknown) => {
          reportedFailure = error;
          throw error;
        });
        expect(step).toMatchObject({
          termination: "timeout",
          signal: "SIGKILL",
          stdoutTail: expect.stringContaining("Doctor busy"),
          failureFacts: [expect.objectContaining({ code: "timeout" })],
        });
        assert(childPid);
        expect(isChildProcessTreeAlive({ pid: childPid })).toBe(false);
        assert(writer);
        expect(isChildProcessTreeAlive(writer)).toBe(false);
        expect(steps).toContainEqual(
          expect.objectContaining({
            name: "doctor process settlement",
            exitCode: 0,
            advisory: expect.objectContaining({
              message: expect.stringContaining("openclaw update repair"),
            }),
          }),
        );
        fence.assertCurrent();
      });
      if (identityAvailable) {
        await execution;
        expect(readCommandClaims()).toEqual([]);
      } else {
        const failure = await execution.catch((error: unknown) => error);
        assert(reportedFailure instanceof AggregateError);
        expect(reportedFailure.message).toBe("Doctor settlement recording failed");
        expect(reportedFailure.cause).toBe(reportingError);
        expect(reportedFailure.errors).toContain(reportingError);
        expect(reportedFailure.errors.some(hasCommandProcessCleanupError)).toBe(true);
        expect(hasCommandProcessCleanupError(failure)).toBe(true);
        assert(writer);
        expect(isChildProcessTreeAlive(writer)).toBe(true);
        expectRetainedCommandClaims(writer.pid, [root, serviceRoot]);
        expect(steps).toContainEqual(
          expect.objectContaining({
            name: "doctor process settlement",
            exitCode: 1,
            failureFacts: [
              expect.objectContaining({
                code: "doctor-processes-unsettled",
                message: expect.stringContaining(String(writer.pid)),
              }),
            ],
          }),
        );
      }
    } finally {
      if (writer) {
        expect(await settleCommandProcessGroups([writer])).toMatchObject({ settled: true });
      }
    }
  },
);

it.skipIf(process.platform === "win32").each([
  { identityAvailable: true, frozen: false },
  { identityAvailable: false, frozen: false },
  { identityAvailable: true, frozen: true },
])(
  "settles standalone Doctor writers after output capture rejects (identity=$identityAvailable, frozen=$frozen)",
  async ({ identityAvailable, frozen }) => {
    const original = new Error("Doctor output observer failed");
    if (frozen) {
      Object.freeze(original);
    }
    const steps: UpdateStepResult[] = [];
    let output = "";
    let writer: CommandProcessIdentity | undefined;
    let doctorPid: number | undefined;
    try {
      const error = await runUpdateDoctorProcess(
        { runId: randomUUID(), root, onProcessSettlement: (step) => steps.push(step) },
        busyDoctorWriterArgv(identityAvailable),
        {
          cwd: root,
          input: "",
          timeoutMs: 5_000,
          env: {
            ...env,
            [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: path.join(root, "doctor-result.json"),
          },
          beforeInput: (pid) => {
            doctorPid = pid;
          },
          onOutputChunk: (chunk, stream) => {
            if (stream !== "stdout") {
              return;
            }
            output += chunk.toString();
            const match = /Doctor busy (\d+)/.exec(output);
            if (match) {
              const pid = Number(match[1]);
              writer = { pid, startedAt: getProcessInstanceStartTime(pid) };
              throw original;
            }
          },
        },
      ).catch((cause: unknown) => cause);
      assert(doctorPid);
      assert(writer, output);
      expect(isChildProcessTreeAlive({ pid: doctorPid })).toBe(false);
      expect(isChildProcessTreeAlive(writer)).toBe(!identityAvailable);
      expect(hasCommandProcessCleanupError(error)).toBe(!identityAvailable);
      if (identityAvailable) {
        expect(readCommandClaims()).toEqual([]);
        expect(readHandoffClaims().find((claim) => claim.install_root === root)).toBeUndefined();
      } else {
        expectRetainedCommandClaims(writer.pid, [root]);
        const anchor = readHandoffClaims().find((claim) => claim.install_root === root);
        assert(anchor);
        expect(anchor.owner).toMatch(/^doctor:/);
        expect(parseManagedHandoffLeasePayload(anchor.payload_json)).toMatchObject({
          version: 2,
          helper: { pid: doctorPid },
          executor: { pid: doctorPid },
          action: { kind: "update" },
        });
      }
      if (identityAvailable) {
        if (frozen) {
          expect(error).toMatchObject({ message: original.message, cause: original });
        } else {
          expect(error).toBe(original);
        }
        expect(steps).toContainEqual(
          expect.objectContaining({
            name: "doctor process settlement",
            exitCode: 0,
            advisory: expect.objectContaining({
              message: expect.stringContaining("openclaw update repair"),
            }),
          }),
        );
      } else {
        expect(error).toMatchObject({ cause: original });
        expect(steps).toContainEqual(
          expect.objectContaining({
            name: "doctor process settlement",
            exitCode: 1,
            failureFacts: [
              expect.objectContaining({
                code: "doctor-processes-unsettled",
                message: expect.stringContaining(String(writer.pid)),
              }),
            ],
          }),
        );
      }
      const restore = vi.fn(async () => {});
      await settleUpdateDoctorMaintenance(
        { error },
        restore,
        async () => {},
        "Doctor recovery failed",
      );
      expect(restore).toHaveBeenCalledTimes(identityAvailable ? 1 : 0);
    } finally {
      if (writer) {
        expect(await settleCommandProcessGroups([writer])).toMatchObject({ settled: true });
      }
    }
  },
);

it("does not invent unsettled writers when the Doctor executable never starts", async () => {
  const resultPath = path.join(root, "doctor-not-started.json");
  const steps: UpdateStepResult[] = [];
  const error = await runUpdateDoctorProcess(
    { runId: randomUUID(), root, onProcessSettlement: (step) => steps.push(step) },
    [path.join(root, "missing-doctor-executable")],
    {
      cwd: root,
      timeoutMs: 1_000,
      env: { ...env, [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: resultPath },
    },
  ).catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: "ENOENT" });
  expect(hasCommandProcessCleanupError(error)).toBe(false);
  expect(steps).toEqual([]);
  expect(fs.existsSync(`${resultPath}.processes`)).toBe(false);
});

function busyDoctorWriterArgv(identityAvailable: boolean): string[] {
  // Prepare the whole child graph before its deadline, alongside its executor.
  const custodyModule = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.doctorCustody);
  const spawnModule = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.processSpawn);
  const executorModule = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor);
  return [
    process.execPath,
    "--input-type=module",
    "-e",
    `
                import { once } from 'node:events';
                import { writeSync } from 'node:fs';
                import { retainUpdateDoctorProcesses } from ${JSON.stringify(custodyModule.href)};
                import { withCommandProcessScope, spawnCommand } from ${JSON.stringify(spawnModule.href)};
                process.on('SIGTERM', () => {});
                  let input = '';
                  process.stdin.setEncoding('utf8');
                  process.stdin.on('data', chunk => { input += chunk; });
                  process.stdin.resume();
                  process.stdin.on('end', async () => {
                    const run = async (fence, commandAuthority) => {
                    const custody = await retainUpdateDoctorProcesses(fence?.assertCurrent, commandAuthority);
                    const reserve = custody.reserve;
                    if (!${identityAvailable}) custody.reserve = (...args) => {
                      const slot = reserve(...args);
                      return { ...slot, spawned: ({ pid }) => slot.spawned({ pid, startedAt: null }) };
                    };
                    await withCommandProcessScope(async () => {
                    const probe = await spawnCommand([${JSON.stringify(path.join(root, "missing-doctor-probe"))}],
                      { stdio: 'ignore', reject: false });
                    if (probe.code !== 'ENOENT') throw new Error('Expected a failed Doctor probe');
                    const child = spawnCommand([process.execPath, '-e',
                      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); for (;;) {}"
                    ], { stdio: ['ignore', 'pipe', 'ignore'], buffer: false, reject: false });
                    await once(child.stdout, 'data');
                    writeSync(1, 'Doctor busy ' + child.pid + '\\n');
                    for (;;) {}
                    }, undefined, custody);
                    };
                    if (input) {
                      const { withDelegatedUpdateCommandExecutor } = await import(${JSON.stringify(executorModule.href)});
                      const doctor = JSON.parse(input);
                      await withDelegatedUpdateCommandExecutor(doctor.executor, doctor.runId, doctor.root, run);
                    } else {
                      await run();
                    }
                });
              `,
  ];
}
