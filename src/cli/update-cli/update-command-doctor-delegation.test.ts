import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import {
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "../../infra/update-managed-service-handoff-database.js";
import { parseManagedHandoffLeasePayload } from "../../infra/update-managed-service-handoff-schema.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { isChildProcessTreeAlive } from "../../process/child-process-tree.js";
import { settleCommandProcessGroups } from "../../process/command-process-custody.js";
import type { CommandProcessIdentity } from "../../process/command-process-custody.types.js";
import { hasCommandProcessCleanupError, type SpawnResult } from "../../process/exec-result.js";
import * as processRunner from "../../process/exec.js";
import * as processDeadline from "../../process/process-deadline.js";
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

function withDoctor<T>(
  work: (context: {
    fence: UpdateRecoveryFence;
    opts: UpdateCommandOptions;
    guards: ReturnType<typeof createUpdateCommandExecutionGuards>;
    options: Parameters<typeof runPackageUpdateDoctor>[0];
  }) => Promise<T>,
  requester = false,
) {
  const runId = randomUUID();
  return withUpdateCommandExecutor(runId, async (executor) => {
    const fence = await executor.enter(root, { serviceRoot });
    const run: NonNullable<UpdateCommandOptions["run"]> = { runId, env, executorFence: fence };
    if (requester) {
      run.requesterAuthority = {
        requester: { channel: "test", senderId: "owner" },
        isCurrent: () => true,
      };
    }
    const opts = { run };
    const guards = createUpdateCommandExecutionGuards(opts, root);
    return work({
      opts,
      guards,
      fence,
      options: {
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
      },
    });
  });
}

function standaloneDoctor(
  steps: UpdateStepResult[],
  argv: string[],
  options: DoctorProcessOptions,
) {
  return runUpdateDoctorProcess(
    { runId: randomUUID(), root, onProcessSettlement: (step) => steps.push(step) },
    argv,
    {
      cwd: root,
      input: "",
      timeoutMs: 5_000,
      ...options,
      env: {
        ...env,
        [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: path.join(root, "doctor-result.json"),
      },
    },
  );
}

type DoctorProcessOptions = Exclude<
  Parameters<typeof processRunner.runUtf8CommandWithTimeout>[1],
  number
>;

function interceptDoctor(
  argv: string[],
  configure: (options: DoctorProcessOptions) => DoctorProcessOptions = (options) => options,
  completed?: (result: SpawnResult, options: DoctorProcessOptions) => Promise<void>,
) {
  const run = processRunner.runUtf8CommandWithTimeout;
  const child: { pid?: number; result?: SpawnResult } = {};
  vi.spyOn(processRunner, "runUtf8CommandWithTimeout").mockImplementation(
    async (_argv, options) => {
      assert(typeof options !== "number", "Doctor supplies input-admission options");
      const configured = configure(options);
      child.result = await run(argv, {
        ...configured,
        beforeInput(pid, spawnedArgv) {
          child.pid = pid;
          configured.beforeInput?.(pid, spawnedArgv);
        },
      });
      if (completed) {
        await completed(child.result, options);
      }
      return child.result;
    },
  );
  return child;
}

function receivingDoctor(keepAlive = false) {
  return [
    process.execPath,
    "-e",
    `process.stdin.on('data',x=>require('node:fs').appendFileSync(process.argv[1],x));${keepAlive ? "setInterval(()=>{},1000);" : "process.stdin.resume();"}`,
    received,
  ];
}

async function expectChildExited(pid: number | undefined) {
  assert(typeof pid === "number", "Doctor child must have spawned");
  expect(await waitForPidToExit(pid)).toBe(true);
}

function expectUnchangedInput() {
  expect(fs.existsSync(received)).toBe(false);
  expect(fs.readFileSync(configPath, "utf8")).toBe("{}\n");
}

function expectSettlement(steps: UpdateStepResult[], writerPid?: number) {
  expect(steps).toContainEqual(
    expect.objectContaining({
      name: "doctor process settlement",
      exitCode: writerPid === undefined ? 0 : 1,
      ...(writerPid === undefined
        ? {
            advisory: expect.objectContaining({
              message: expect.stringContaining("openclaw update repair"),
            }),
          }
        : {
            failureFacts: [
              expect.objectContaining({
                code: "doctor-processes-unsettled",
                message: expect.stringContaining(String(writerPid)),
              }),
            ],
          }),
    }),
  );
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
    return payload?.version === 2 && payload.action.kind === "update" && payload.action.custody;
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
      action: { kind: "update", custody: "bound" },
    });
  }
}

it.each(["recovery-pending", "A-revoked", "B-revoked"] as const)(
  "withholds all Doctor input and settles the real child when %s before input",
  async (change) => {
    let child: ReturnType<typeof interceptDoctor> | undefined;
    const work = withDoctor(async ({ fence, opts, options: doctor }) => {
      child = interceptDoctor(receivingDoctor(), (options) => {
        expect(() => fence.assertCurrent()).toThrow("The update process is still running.");
        return {
          ...options,
          beforeInput(pid, spawnedArgv) {
            if (change === "recovery-pending") {
              opts.recovery = {};
            }
            if (change === "A-revoked" || change === "B-revoked") {
              const db = new DatabaseSync(path.join(root, "tmp", "managed-update-handoffs.sqlite"));
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
        };
      });
      await runPackageUpdateDoctor(doctor);
    }, true);
    await expect(work).rejects.toThrow();
    await expectChildExited(child?.pid);
    expectUnchangedInput();
  },
);

it("retains the settled Doctor failure outcome", async () => {
  const exitCode = 23;
  let resultPath: string | undefined;
  const steps: UpdateStepResult[] = [];
  const onStepComplete = vi.fn();
  await withDoctor(async ({ fence, guards, options: doctor }) => {
    const child = interceptDoctor(
      [
        process.execPath,
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.exit(Number(process.argv[1])));",
        String(exitCode),
      ],
      undefined,
      async (result, options) => {
        expect(result).toMatchObject({ cleanup: "normal", code: exitCode });
        expect(onStepComplete).not.toHaveBeenCalled();
        resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
        assert(resultPath);
        await writeUpdatePostInstallDoctorResult({
          resultPath,
          result: {
            status: "error",
            configChanges: [{ kind: "migration", message: "Moved model allowlist." }],
          },
        });
      },
    );
    const result = await runPackageUpdateDoctor({
      ...doctor,
      progress: { onStepComplete },
      results: steps,
    }).catch((cause: unknown) => cause);
    expect(result).toMatchObject({ exitCode: 23 });
    guards.assertCurrent();
    await expectChildExited(child.pid);
    fence.assertCurrent();
    assert(resultPath);
    expect(fs.existsSync(resultPath)).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).toBe("{}\n");
  }, true);
});

it("preserves before-input failure after proving the delegated grant was withheld", async () => {
  let child: ReturnType<typeof interceptDoctor> | undefined;
  const steps: UpdateStepResult[] = [];
  const work = withDoctor(async ({ options: doctor }) => {
    child = interceptDoctor(receivingDoctor(true), (options) => ({
      ...options,
      beforeInput(pid, spawnedArgv) {
        options.beforeInput?.(pid, spawnedArgv);
        throw new Error("injected before-input failure after live child binding");
      },
    }));
    await runPackageUpdateDoctor({ ...doctor, results: steps });
  });
  const failure = await work.catch((error: unknown) => error);
  expect(hasCommandProcessCleanupError(failure)).toBe(false);
  expect(failure).toMatchObject({
    message: "injected before-input failure after live child binding",
    cleanup: process.platform === "win32" ? "forced" : "cooperative",
  });
  expect(steps.filter((step) => step.name === "doctor process settlement")).toEqual([]);
  await expectChildExited(child?.pid);
  expectUnchangedInput();
});

it("does not treat standalone input withholding as a delegated no-writer proof", async () => {
  const original = new Error("Standalone input refused");
  let pid: number | undefined;
  const steps: UpdateStepResult[] = [];
  const failure = await standaloneDoctor(steps, receivingDoctor(), {
    input: "must not be delivered",
    beforeInput: (spawnedPid) => {
      pid = spawnedPid;
      throw original;
    },
  }).catch((error: unknown) => error);
  assert(pid);
  expect(hasCommandProcessCleanupError(failure)).toBe(true);
  expect(failure).toMatchObject({ cause: original });
  expectSettlement(steps, pid);
  expect(await waitForPidToExit(pid)).toBe(true);
  expectUnchangedInput();
});

it.skipIf(process.platform === "win32").for([true, false])(
  "settles a CPU-bound Doctor at its deadline or records unresolved writer identity (identity=%s)",
  async (identityAvailable, { signal }) => {
    let child: ReturnType<typeof interceptDoctor> | undefined;
    let writer: CommandProcessIdentity | undefined;
    const steps: UpdateStepResult[] = [];
    const reportingError = new Error("settlement progress could not be recorded");
    let reportedFailure: unknown;
    const ready = createDeferred();
    const cleanup = new AbortController();
    let deadline: ReturnType<typeof controlDoctorDeadline> | undefined;
    let execution: Promise<void> | undefined;
    let output = "";
    try {
      execution = withDoctor(async ({ fence, options: doctor }) => {
        child = interceptDoctor(busyDoctorWriterArgv(identityAvailable), (options) => {
          deadline = controlDoctorDeadline();
          return {
            ...options,
            signal: AbortSignal.any([
              signal,
              cleanup.signal,
              ...(options.signal ? [options.signal] : []),
            ]),
            onOutputChunk(chunk, stream) {
              const observed = options.onOutputChunk?.(chunk, stream);
              if (stream === "stdout") {
                output += chunk.toString();
                const match = /Doctor busy (\d+)/.exec(output);
                if (match) {
                  const pid = Number(match[1]);
                  writer = { pid, startedAt: getProcessInstanceStartTime(pid) };
                  ready.resolve();
                }
              }
              return observed;
            },
          };
        });
        const step = await runPackageUpdateDoctor({
          ...doctor,
          results: steps,
          progress: {
            onStepComplete: (completedStep) => {
              if (identityAvailable || completedStep.name !== "doctor process settlement") {
                return undefined;
              }
              const reporting = Promise.resolve().then(() => {
                throw reportingError;
              });
              // Observe the expected rejection without changing the Promise returned to its owner.
              void reporting.catch(() => {});
              return reporting;
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
        assert(child?.pid);
        expect(isChildProcessTreeAlive({ pid: child.pid })).toBe(false);
        assert(writer);
        expect(isChildProcessTreeAlive(writer)).toBe(false);
        expectSettlement(steps);
        fence.assertCurrent();
      });
      await withinTest(
        awaitGateBeforeSettlement(
          ready.promise,
          execution,
          "Doctor settled before its busy receipt",
        ),
        signal,
      );
      assert(deadline);
      deadline.release(true);
      if (identityAvailable) {
        await withinTest(execution, signal);
        expect(readCommandClaims()).toEqual([]);
      } else {
        const failure = await withinTest(
          execution.catch((error: unknown) => error),
          signal,
        );
        assert(reportedFailure instanceof AggregateError);
        expect(reportedFailure.message).toBe("Doctor settlement recording failed");
        expect(reportedFailure.cause).toBe(reportingError);
        expect(reportedFailure.errors).toContain(reportingError);
        expect(reportedFailure.errors.some(hasCommandProcessCleanupError)).toBe(true);
        expect(hasCommandProcessCleanupError(failure)).toBe(true);
        assert(writer);
        expect(isChildProcessTreeAlive(writer)).toBe(true);
        expectRetainedCommandClaims(writer.pid, [root, serviceRoot]);
        expectSettlement(steps, writer.pid);
      }
      const doctorResult = child?.result;
      assert(doctorResult);
      expect(doctorResult, doctorResult.stderr).toMatchObject({
        termination: "timeout",
        cleanup: "forced",
        signal: "SIGKILL",
      });
      const pid = Number(/Doctor busy (\d+)/.exec(doctorResult.stdout)?.[1]);
      assert(pid > 0, doctorResult.stderr);
    } finally {
      deadline?.close();
      cleanup.abort();
      await execution?.catch(() => {});
      await settleBusyDoctorWriter(writer);
    }
  },
);

it.skipIf(process.platform === "win32").for([
  { identityAvailable: true, frozen: false },
  { identityAvailable: false, frozen: false },
  { identityAvailable: true, frozen: true },
])(
  "settles standalone Doctor writers after output capture rejects (identity=$identityAvailable, frozen=$frozen)",
  async ({ identityAvailable, frozen }, { signal }) => {
    const original = new Error("Doctor output observer failed");
    if (frozen) {
      Object.freeze(original);
    }
    const steps: UpdateStepResult[] = [];
    let output = "";
    let writer: CommandProcessIdentity | undefined;
    let doctorPid: number | undefined;
    const cleanup = new AbortController();
    const deadline = controlDoctorDeadline();
    let execution: Promise<unknown> | undefined;
    try {
      execution = standaloneDoctor(steps, busyDoctorWriterArgv(identityAvailable), {
        signal: AbortSignal.any([signal, cleanup.signal]),
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
            deadline.release(false);
            throw original;
          }
        },
      }).catch((cause: unknown) => cause);
      const error = await withinTest(execution, signal);
      assert(doctorPid);
      assert(writer, output);
      expect(isChildProcessTreeAlive({ pid: doctorPid })).toBe(false);
      expect(isChildProcessTreeAlive(writer)).toBe(!identityAvailable);
      expect(hasCommandProcessCleanupError(error)).toBe(!identityAvailable);
      if (identityAvailable) {
        expect(readCommandClaims()).toEqual([]);
        expect(readHandoffClaims().find((claim) => claim.install_root === root)).toBeUndefined();
        if (frozen) {
          expect(error).toMatchObject({ message: original.message, cause: original });
        } else {
          expect(error).toBe(original);
        }
        expectSettlement(steps);
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
        expect(error).toMatchObject({ cause: original });
        expectSettlement(steps, writer.pid);
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
      deadline.close();
      cleanup.abort();
      await execution;
      await settleBusyDoctorWriter(writer);
    }
  },
);

/** Hold fixture startup outside the deadline without freezing native cleanup or lease clocks. */
function controlDoctorDeadline() {
  const nativeTimeout = processDeadline.setProcessTimeout;
  let timer: ReturnType<typeof nativeTimeout> | undefined;
  let release: ((expire: boolean) => void) | undefined;
  let active = true;
  const spy = vi
    .spyOn(processDeadline, "setProcessTimeout")
    .mockImplementationOnce((callback, delayMs) => {
      const inOwner = AsyncLocalStorage.snapshot();
      release = (expire) => {
        expect(delayMs).toBe(5_000);
        if (active) {
          timer = inOwner(() => nativeTimeout(callback, expire ? 0 : delayMs));
        }
      };
      return {
        clear() {
          active = false;
          timer?.clear();
        },
        refresh() {
          timer?.refresh();
        },
      };
    });
  return {
    release(expire: boolean) {
      spy.mockRestore();
      assert(release, "Doctor deadline was not registered");
      const deliver = release;
      release = undefined;
      deliver(expire);
    },
    close() {
      spy.mockRestore();
      active = false;
      timer?.clear();
    },
  };
}

async function settleBusyDoctorWriter(input: CommandProcessIdentity | undefined) {
  let writer = input;
  const receiptPath = path.join(root, "writer-cleanup.json");
  if (!writer && fs.existsSync(receiptPath)) {
    const receipt: unknown = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    assert(receipt && typeof receipt === "object" && "pid" in receipt && "startedAt" in receipt);
    assert(typeof receipt.pid === "number");
    assert(typeof receipt.startedAt === "number" || receipt.startedAt === null);
    writer = { pid: receipt.pid, startedAt: receipt.startedAt };
  }
  if (writer) {
    expect(await settleCommandProcessGroups([writer])).toMatchObject({ settled: true });
  }
}

function busyDoctorWriterArgv(identityAvailable: boolean): string[] {
  // Use the prepared child graph; readiness gates its per-process evaluation cost.
  const custodyModule = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.doctorCustody);
  const spawnModule = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.processSpawn);
  const executorModule = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor);
  return [
    process.execPath,
    "--input-type=module",
    "-e",
    `
                import { once } from 'node:events';
                import { writeFileSync, writeSync } from 'node:fs';
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
                    custody.reserve = (...args) => {
                      const slot = reserve(...args);
                      return { ...slot, spawned: identity => {
                        writeFileSync(${JSON.stringify(path.join(root, "writer-cleanup.json"))}, JSON.stringify(identity));
                        slot.spawned(${identityAvailable} ? identity : { pid: identity.pid, startedAt: null });
                      } };
                    };
                    await withCommandProcessScope(async () => {
                    const probe = await spawnCommand([${JSON.stringify(path.join(root, "missing-doctor-probe"))}],
                      { stdio: 'ignore', reject: false });
                    if (probe.code !== 'ENOENT') throw new Error('Expected a failed Doctor probe');
                    const child = spawnCommand([process.execPath, '-e',
                      "process.on('SIGTERM', () => {}); require('node:fs').writeSync(1, 'ready'); for (;;) {}"
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
