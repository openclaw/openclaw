import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  nextEventLoopTurn,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { waitForSignalExitBarriers } from "../cli/signal-exit-barrier.js";
import { runDoctorProcess } from "../commands/doctor-process.js";
import { listDirectoryTreeStrictSync } from "../infra/directory-walk.js";
import * as runtimeProcess from "../infra/runtime-process-url.js";
import * as commandIdentity from "../process/command-process-identity.js";
import {
  hasCommandProcessCleanupError,
  readCommandProcessCleanup,
  recordCommandProcessCleanup,
  type SpawnResult,
} from "../process/exec-result.js";
import * as processRunner from "../process/exec-runner.js";
import * as commandSpawn from "../process/exec-spawn.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { executeSystemAgentOperation as execute } from "./operations-execute.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([false, true])(
  "reaps cancelled hosted Doctor work (ignores SIGTERM: %s)",
  async (ignore) => {
    const fixture = path.join(tempDirs.make("hosted-doctor-cancel-"), "doctor.mjs");
    const receipt = `${fixture}.signal`;
    fs.writeFileSync(
      fixture,
      `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(receipt)}, "SIGTERM");
  ${ignore ? "" : "process.exit(143);"}
});
setInterval(() => {}, 1000);
process.stdout.write("ready:" + process.pid + "\\n");
`,
    );
    const resolve = runtimeProcess.resolveRuntimeProcessEntrypointUrl;
    const doctor = vi
      .spyOn(runtimeProcess, "resolveRuntimeProcessEntrypointUrl")
      .mockImplementation((name) => (name === "doctor" ? pathToFileURL(fixture) : resolve(name)));
    const { runtime } = createSystemAgentTestRuntime();
    let pid: number | undefined;
    const log = runtime.log;
    try {
      await expect(
        withCommandProcessScope(async (stop) => {
          runtime.log = (line) => {
            log(line);
            if (typeof line === "string" && line.startsWith("ready:")) {
              pid = Number(line.slice(6));
              stop();
            }
          };
          await execute({ kind: "doctor" }, runtime);
        }),
      ).rejects.toThrow(/aborted/i);
      expect(fs.readFileSync(receipt, "utf8")).toBe("SIGTERM");
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      doctor.mockRestore();
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already reaped by the operation owner.
        }
      }
    }
  },
);

it.skipIf(process.platform !== "linux" && process.platform !== "android")(
  "retains every Doctor lifetime until startup cancellation cleanup completes",
  async ({ signal }) => {
    const fixture = path.join(tempDirs.make("hosted-doctor-birth-"), "doctor.mjs");
    const receipt = `${fixture}.signal`;
    fs.writeFileSync(
      fixture,
      `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(receipt)}, "SIGTERM"); process.exit(143); });
setInterval(() => {}, 1000);
process.stdout.write("ready:" + process.pid + "\\n");`,
    );
    const resolve = runtimeProcess.resolveRuntimeProcessEntrypointUrl;
    const doctor = vi
      .spyOn(runtimeProcess, "resolveRuntimeProcessEntrypointUrl")
      .mockImplementation((name) => (name === "doctor" ? pathToFileURL(fixture) : resolve(name)));
    const birth = createDeferredCore();
    const readIdentity = commandIdentity.readCommandProcessStartTime;
    const identity = vi
      .spyOn(commandIdentity, "readCommandProcessStartTime")
      .mockImplementationOnce(async (...args) => {
        const observed = await readIdentity(...args);
        await birth.promise;
        return observed;
      });
    const returned = createDeferredCore<SpawnResult>();
    const run = processRunner.runUtf8CommandWithTimeout;
    const runner = vi
      .spyOn(processRunner, "runUtf8CommandWithTimeout")
      .mockImplementation(async (...args) => {
        const result = await run(...args);
        returned.resolve(result);
        return result;
      });
    let child: ChildProcess | undefined;
    let closed: Promise<unknown> | undefined;
    const spawn = commandSpawn.spawnCommandWithInvocation;
    const spawned = vi
      .spyOn(commandSpawn, "spawnCommandWithInvocation")
      .mockImplementation((...args) => {
        const result = spawn(...args);
        child = result.child.nodeChildProcess;
        closed = once(child, "close");
        void closed.catch(() => {});
        return result;
      });
    const { runtime } = createSystemAgentTestRuntime();
    const scope = new AsyncWorkScope();
    const abort = new AbortController();
    const finished = vi.fn();
    const callbackReturned = vi.fn();
    const scopeDrained = vi.fn();
    const exitDrained = vi.fn();
    let pid: number | undefined;
    let raw: SpawnResult | undefined;
    let drains: Promise<unknown> | undefined;
    let nested: Promise<void> | undefined;
    let nestedOutcome: Promise<unknown> | undefined;
    const work = scope
      .run(() =>
        withCommandProcessScope(async () => {
          nested = withCommandProcessScope(async (stop) => {
            runtime.log = (line) => {
              if (typeof line === "string" && line.startsWith("ready:")) {
                pid = Number(line.slice(6));
                stop();
              }
            };
            await runDoctorProcess(runtime);
          });
          nestedOutcome = nested.catch((error: unknown) => error);
          await withinTest(
            awaitGateBeforeSettlement(
              returned.promise,
              nested,
              "Doctor did not return its provisional result",
            ),
            signal,
          );
          // Only declared cleanup can hold the parent after its callback returns.
          callbackReturned();
          return "callback returned";
        }, abort.signal),
      )
      .finally(finished);
    const outcome = work.catch((error: unknown) => error);
    try {
      raw = await withinTest(
        awaitGateBeforeSettlement(
          returned.promise,
          work,
          "Doctor did not return its provisional result",
        ),
        signal,
      );
      expect(raw).toMatchObject({ termination: "signal", cleanup: "uncertain" });
      expect(readCommandProcessCleanup(raw)).toBeDefined();
      drains = Promise.all([
        scope.drain().finally(scopeDrained),
        waitForSignalExitBarriers().finally(exitDrained),
      ]);
      void drains.catch(() => {});
      await nextEventLoopTurn();
      expect(callbackReturned).toHaveBeenCalledOnce();
      expect(finished).not.toHaveBeenCalled();
      expect(scopeDrained).not.toHaveBeenCalled();
      expect(exitDrained).not.toHaveBeenCalled();
      expect(scope.hasPendingWork).toBe(true);
      birth.resolve();
      await expect(withinTest(work, signal)).resolves.toBe("callback returned");
      await expect(withinTest(nested!, signal)).rejects.toThrow(/aborted/i);
      await withinTest(drains, signal);
      expect(scopeDrained).toHaveBeenCalledOnce();
      expect(exitDrained).toHaveBeenCalledOnce();
      expect(scope.hasPendingWork).toBe(false);
      expect(fs.readFileSync(receipt, "utf8")).toBe("SIGTERM");
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      birth.resolve();
      abort.abort();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await outcome;
      await nestedOutcome;
      await closed?.catch(() => {});
      if (raw) {
        await readCommandProcessCleanup(raw)?.catch(() => {});
      }
      await drains?.catch(() => {});
      spawned.mockRestore();
      runner.mockRestore();
      identity.mockRestore();
      doctor.mockRestore();
    }
  },
);

it.for(["uncertain", "rejected", "missing"] as const)(
  "preserves %s Doctor cleanup ahead of cancellation",
  async (ending, { signal }) => {
    const cleanup = createDeferredCore<NonNullable<SpawnResult["cleanup"]>>();
    const entered = createDeferredCore();
    const abort = new AbortController();
    const failure = new Error("cleanup observation failed");
    const runner = vi
      .spyOn(processRunner, "runUtf8CommandWithTimeout")
      .mockImplementation(async () => {
        entered.resolve();
        abort.abort();
        return recordCommandProcessCleanup<SpawnResult>(
          {
            stdout: "",
            stderr: "",
            code: null,
            signal: "SIGTERM",
            killed: true,
            termination: "signal",
            cleanup: "uncertain",
          },
          ending === "missing" ? undefined : cleanup.promise,
        );
      });
    const { runtime } = createSystemAgentTestRuntime();
    const scope = new AsyncWorkScope();
    const finished = vi.fn();
    const scopeDrained = vi.fn();
    const exitDrained = vi.fn();
    let doctorOutcome: Promise<unknown> | undefined;
    const work = scope
      .run(() =>
        withCommandProcessScope(async () => {
          const doctor = runDoctorProcess(runtime);
          doctorOutcome = doctor.catch((error: unknown) => error);
          await doctor;
        }, abort.signal),
      )
      .finally(finished);
    const outcome = work.catch((error: unknown) => error);
    const drains = Promise.allSettled([
      scope.drain().finally(scopeDrained),
      waitForSignalExitBarriers().finally(exitDrained),
    ]);
    try {
      await withinTest(entered.promise, signal);
      if (ending !== "missing") {
        await nextEventLoopTurn();
        expect(finished).not.toHaveBeenCalled();
        expect(scopeDrained).not.toHaveBeenCalled();
        expect(exitDrained).not.toHaveBeenCalled();
      }
      if (ending === "rejected") {
        cleanup.reject(failure);
      } else {
        cleanup.resolve("uncertain");
      }
      const scopeError = await withinTest(outcome, signal);
      const [, exitResult] = await withinTest(drains, signal);
      expect(exitResult.status).toBe("rejected");
      const errors = [await doctorOutcome, scopeError];
      if (exitResult.status === "rejected") {
        errors.push(exitResult.reason);
      }
      for (const error of errors) {
        expect(hasCommandProcessCleanupError(error)).toBe(true);
        if (ending === "rejected") {
          expect(collectNestedErrorCandidates(error)).toContain(failure);
        }
      }
      expect(scopeDrained).toHaveBeenCalledOnce();
      expect(exitDrained).toHaveBeenCalledOnce();
      expect(scope.hasPendingWork).toBe(false);
    } finally {
      cleanup.resolve("uncertain");
      await outcome;
      await drains;
      runner.mockRestore();
    }
  },
);

it("keeps the host responsive while a hosted Doctor process performs synchronous work", async () => {
  const fixture = path.join(tempDirs.make("hosted-doctor-process-"), "doctor.mjs");
  const listener = await reserveTestPortListener({
    offsets: [0],
    createListener: () => createServer((_request, response) => response.end("host responded 🦞")),
  });
  const request = `fetch("http://127.0.0.1:${listener.claim.port}/doctor").then(async response => process.stdout.write(await response.text()));`;
  fs.writeFileSync(
    fixture,
    `import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
assert.notEqual(process.pid, ${process.pid});
assert.equal(process.cwd(), ${JSON.stringify(process.cwd())});
process.stdout.write(execFileSync(process.execPath, ["-e", ${JSON.stringify(request)}]));
process.stderr.write("doctor diagnostic 🦞\\n");
`,
  );
  const resolve = runtimeProcess.resolveRuntimeProcessEntrypointUrl;
  const doctor = vi
    .spyOn(runtimeProcess, "resolveRuntimeProcessEntrypointUrl")
    .mockImplementation((name) => (name === "doctor" ? pathToFileURL(fixture) : resolve(name)));
  const { runtime, lines } = createSystemAgentTestRuntime();
  try {
    await expect(execute({ kind: "doctor" }, runtime)).resolves.toEqual({ applied: false });
    expect(lines).toContain("host responded 🦞");
    expect(lines).toContain("doctor diagnostic 🦞");
  } finally {
    doctor.mockRestore();
    await listener.releaseListener();
    await listener.claim.release();
  }
});

it.each([
  { gateway: {}, finding: "gateway.mode is unset" },
  { gateway: { port: "abc" }, finding: "gateway.port" },
])(
  "reports $finding without opening or repairing an unreadable state database",
  ({ gateway, finding }) =>
    withOpenClawTestState(
      {
        label: "hosted-doctor-readonly",
        layout: "split",
        // Compiled test workers can still resolve the checkout's source Plugin SDK.
        env: {
          OPENCLAW_TEST_RUNTIME_LOG: "1",
          OPENCLAW_TEST_CONSOLE: "1",
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.resolve("scripts/tsx.mjs")).href}`,
        },
      },
      async (state) => {
        await state.writeConfig({
          gateway,
          agents: { entries: {} },
          plugins: { enabled: false },
          memory: { search: { enabled: false } },
        });
        const database = state.statePath("state", "openclaw.sqlite");
        fs.mkdirSync(path.dirname(database), { recursive: true });
        fs.writeFileSync(database, "unreadable SQLite state");
        const snapshot = () =>
          listDirectoryTreeStrictSync(state.root).map(({ relativePath: relative }) => {
            const filename = path.join(state.root, relative);
            const stat = fs.lstatSync(filename, { bigint: true });
            return {
              path: relative,
              mode: stat.mode,
              symlinkTarget: stat.isSymbolicLink() ? fs.readlinkSync(filename) : undefined,
              content: stat.isFile() ? fs.readFileSync(filename) : undefined,
              mtimeNs: stat.isFile() ? stat.mtimeNs : undefined,
            };
          });
        const before = snapshot();
        const { runtime, lines } = createSystemAgentTestRuntime();
        await expect(execute({ kind: "doctor" }, runtime)).rejects.toThrow("exit 1");
        expect(snapshot()).toEqual(before);
        expect(lines.join("\n")).toContain(finding);
        expect(lines.join("\n")).toContain("inspections were deferred");
      },
    ),
);
