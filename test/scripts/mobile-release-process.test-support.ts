import { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { clearTimeout as nativeClearTimeout, setTimeout as nativeSetTimeout } from "node:timers";
import { setTimeout as nativeDelay } from "node:timers/promises";
import { expect, it, vi, type TestContext } from "vitest";
import { runBounded } from "../../.github/actions/ios-signing-keychain/keychain.mjs";
import { racePromiseWithAbortSignal } from "../../src/infra/abort-signal.js";
import { hasErrnoCode } from "../../src/infra/errno.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";

type Kill = typeof process.kill;
type Signal = Parameters<Kill>[1];
type SignalFault = (signal: Signal, forward: () => ReturnType<Kill>) => ReturnType<Kill>;
type Outcome = PromiseSettledResult<Awaited<ReturnType<typeof runBounded>>>;

type NativeBoundedFixture = {
  // Verifiers await only this cancellation-aware result; no external async work.
  waitForOutcome: () => Promise<Outcome>;
  exited: () => boolean;
  interceptSignals: (fault: SignalFault) => void;
  release: () => void;
  assertGroupAbsent: () => void;
};

const testNodeExecPath = resolveTestNodeExecPath();
const JOIN_MS = 2_000;
const nativeNow = Date.now;

async function withinCleanupBudget<T>(promise: Promise<T>, deadline: number, label: string) {
  let timer: ReturnType<typeof nativeSetTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = nativeSetTimeout(
          () => reject(new Error(label)),
          Math.max(1, deadline - nativeNow()),
        );
      }),
    ]);
  } finally {
    nativeClearTimeout(timer);
  }
}

async function withNativeBoundedFixture(
  context: Pick<TestContext, "signal" | "onTestFinished">,
  options: { source: string; bufferOutputUntilExit?: boolean },
  verify: (fixture: NativeBoundedFixture) => Promise<void>,
): Promise<void> {
  const lifetime = createFixtureLifetime();
  const finished = new AbortController();
  const signal = AbortSignal.any([context.signal, finished.signal]);
  const originalKill = process.kill.bind(process);
  let child: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let childClosed = false;
  let childExited = false;
  let groupRetired = false;
  let outcome: Promise<Outcome> | undefined;
  let verification: Promise<void> | undefined;
  let root: string | undefined;
  let fault: SignalFault | undefined;
  let restoreSignalObserver: (() => void) | undefined;
  let pendingStop: Promise<void> | undefined;

  const inspectGroup = () => {
    if (groupRetired || !child?.pid) {
      return;
    }
    try {
      originalKill(-child.pid, 0);
    } catch (error) {
      if (hasErrnoCode(error, "ESRCH")) {
        groupRetired = true;
      } else if (!hasErrnoCode(error, "EPERM")) {
        throw error;
      }
    }
  };

  const stop = () =>
    (pendingStop ??= lifetime.verifyCleanup(async () => {
      finished.abort();
      fault = undefined;
      const deadline = nativeNow() + JOIN_MS;
      try {
        if (outcome && !child) {
          throw new Error("Native fixture child identity was not captured");
        }
        // These regression programs contain one process and no descendant launches.
        if (child && !childClosed) {
          child.kill("SIGKILL");
        }
        if (closed) {
          await withinCleanupBudget(closed, deadline, "Native fixture child did not close");
        }
        if (child?.pid) {
          for (;;) {
            inspectGroup();
            if (groupRetired) {
              break;
            }
            if (nativeNow() >= deadline) {
              throw new Error("Native fixture group exit was not confirmed");
            }
            await nativeDelay(Math.min(10, Math.max(1, deadline - nativeNow())));
          }
        }
        if (outcome) {
          await withinCleanupBudget(outcome, deadline, "Bounded command did not settle");
        }
        if (verification) {
          await withinCleanupBudget(
            verification.then(
              () => {},
              () => {},
            ),
            deadline,
            "Native fixture verifier did not settle",
          );
        }
      } finally {
        restoreSignalObserver?.();
      }
    }));
  const onAbort = () => {
    void stop().catch(() => {});
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  context.onTestFinished(async () => {
    context.signal.removeEventListener("abort", onAbort);
    try {
      await stop();
    } catch (cause) {
      // A pending tracked verifier must not turn failed bounded teardown into an
      // unbounded lifetime drain. Keep the root and containing resource claim.
      throw new Error(`Native fixture cleanup unverified; retained ${root ?? "resource claim"}`, {
        cause,
      });
    }
    await lifetime.cleanup();
  });

  await lifetime.run(async () => {
    signal.throwIfAborted();
    root = lifetime.createTempDir("ios-keychain-signal-fixture-");
    const script = path.join(root, "fixture.cjs");
    const gate = path.join(root, "exit");
    fs.writeFileSync(script, options.source);
    const children = channel("child_process");
    const observed: ChildProcess[] = [];
    const capture = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "process" in message &&
        message.process instanceof ChildProcess
      ) {
        observed.push(message.process);
      }
    };
    children.subscribe(capture);
    try {
      outcome = runBounded(testNodeExecPath, [script], {
        env: { PATH: process.env.PATH, EXIT_GATE: gate, NODE_OPTIONS: "" },
        maxOutputBytes: 4_096,
        terminateGraceMs: 0,
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
    } finally {
      children.unsubscribe(capture);
    }
    child = observed.find(
      (candidate) =>
        candidate.spawnargs[0] === testNodeExecPath && candidate.spawnargs[1] === script,
    );
    try {
      if (!child) {
        throw new Error("Expected the exact native fixture child");
      }
      const owned = child;
      const commandOutcome = outcome;
      closed = new Promise<void>((resolve) => {
        owned.once("close", () => {
          childClosed = true;
          resolve();
        });
      });
      if (options.bufferOutputUntilExit) {
        owned.stdout?.pause();
      }
      owned.once("exit", () => {
        childExited = true;
        if (options.bufferOutputUntilExit) {
          owned.stdout?.resume();
        }
      });
      const pid = owned.pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) {
        throw new Error("Native fixture did not acquire a process group");
      }
      const signalObserver = vi.spyOn(process, "kill").mockImplementation((target, sig) => {
        if (target !== -pid) {
          return originalKill(target, sig);
        }
        const forward = () => {
          if (sig !== 0 && childExited && !groupRetired) {
            // These fixtures never fork: a group surviving the sole child's exit
            // is not fresh authority to signal that numeric PGID again.
            inspectGroup();
            if (!groupRetired) {
              throw new Error("Native fixture group identity unavailable after child exit");
            }
          }
          if (groupRetired) {
            throw Object.assign(new Error("retired fixture group"), { code: "ESRCH" });
          }
          try {
            return originalKill(target, sig);
          } catch (error) {
            if (hasErrnoCode(error, "ESRCH")) {
              groupRetired = true;
            }
            throw error;
          }
        };
        return fault ? fault(sig, forward) : forward();
      });
      restoreSignalObserver = () => signalObserver.mockRestore();
      const fixture: NativeBoundedFixture = {
        waitForOutcome: () => racePromiseWithAbortSignal(commandOutcome, signal),
        exited: () => childExited,
        interceptSignals: (next) => {
          signal.throwIfAborted();
          fault = next;
        },
        release: () => {
          signal.throwIfAborted();
          fs.writeFileSync(gate, "exit\n");
        },
        assertGroupAbsent: () => {
          try {
            originalKill(-pid, 0);
          } catch (error) {
            if (hasErrnoCode(error, "ESRCH")) {
              groupRetired = true;
              return;
            }
            throw error;
          }
          throw new Error("Native fixture group still exists");
        },
      };
      verification = lifetime.track(
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return verify(fixture);
        }),
      );
      await verification;
    } finally {
      await stop();
    }
  });
}

const EXIT_WITH_OUTPUT = 'require("node:fs").writeSync(1, "x".repeat(8192));';
const WAIT_FOR_KILL = [
  'process.on("SIGTERM", () => {});',
  "setInterval(() => {}, 1000);",
  'require("node:fs").writeSync(1, "x".repeat(8192));',
].join("\n");
const WAIT_FOR_RELEASE = [
  'const fs = require("node:fs");',
  'process.on("SIGTERM", () => {});',
  "const timer = setInterval(() => { if (fs.existsSync(process.env.EXIT_GATE)) clearInterval(timer); }, 1);",
  'fs.writeSync(1, "x".repeat(8192));',
].join("\n");

function signalError(code: string) {
  return Object.assign(new Error(`injected kill ${code}`), { code });
}

// Four independent owner/error contracts; none adds a production injection seam.
export function registerBoundedSignalTests() {
  if (process.platform === "win32") {
    return;
  }
  for (const persistent of [false, true]) {
    it(`requires confirmed process-group disappearance after ${persistent ? "persistent" : "transient"} EPERM`, async (context) => {
      await withNativeBoundedFixture(context, { source: WAIT_FOR_KILL }, async (fixture) => {
        let probes = 0;
        let nonzeroAfterFault = 0;
        const permission = signalError("EPERM");
        fixture.interceptSignals((signal, forward) => {
          if (signal !== 0) {
            if (probes) {
              nonzeroAfterFault += 1;
            }
            return forward();
          }
          try {
            return forward();
          } catch (error) {
            if (!hasErrnoCode(error, "ESRCH")) {
              throw error;
            }
            probes += 1;
            if (persistent || probes <= 2) {
              throw permission;
            }
            throw error;
          }
        });
        const outcome = await fixture.waitForOutcome();
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") {
          throw new Error("Expected bounded command rejection");
        }
        if (persistent) {
          expect(outcome.reason).toMatchObject({
            message: expect.stringContaining("owned process group did not terminate"),
            cause: permission,
          });
        } else {
          expect(outcome.reason).toMatchObject({
            message: expect.stringContaining("exceeded the 4096-byte output limit"),
          });
        }
        expect(probes).toBeGreaterThanOrEqual(3);
        expect(nonzeroAfterFault).toBe(0);
        fixture.assertGroupAbsent();
      });
    });
  }

  it("preserves the output-limit failure when the group exits before signaling", async (context) => {
    await withNativeBoundedFixture(
      context,
      { source: EXIT_WITH_OUTPUT, bufferOutputUntilExit: true },
      async (fixture) => {
        let permissionFaults = 0;
        let exitedBeforeSignal = false;
        fixture.interceptSignals((signal, forward) => {
          try {
            return forward();
          } catch (error) {
            if (signal === "SIGTERM" && hasErrnoCode(error, "ESRCH")) {
              exitedBeforeSignal = fixture.exited();
              permissionFaults += 1;
              throw signalError("EPERM");
            }
            throw error;
          }
        });
        const outcome = await fixture.waitForOutcome();
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: { message: expect.stringContaining("exceeded the 4096-byte output limit") },
        });
        expect(exitedBeforeSignal).toBe(true);
        expect(permissionFaults).toBe(1);
        fixture.assertGroupAbsent();
      },
    );
  });

  it("preserves a hard signaling error after provisional EPERM", async (context) => {
    await withNativeBoundedFixture(context, { source: WAIT_FOR_RELEASE }, async (fixture) => {
      const permission = signalError("EPERM");
      const ioFailure = signalError("EIO");
      const signals: Array<number | string | undefined> = [];
      fixture.interceptSignals((signal, forward) => {
        if (signal === "SIGTERM") {
          signals.push(signal);
          throw permission;
        }
        if (signal === "SIGKILL") {
          signals.push(signal);
          fixture.release();
          throw ioFailure;
        }
        return forward();
      });
      const outcome = await fixture.waitForOutcome();
      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") {
        throw new Error("Expected bounded command rejection");
      }
      expect(outcome.reason).toBe(ioFailure);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      fixture.assertGroupAbsent();
    });
  });
}
