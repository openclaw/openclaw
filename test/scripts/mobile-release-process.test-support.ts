import { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
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
  waitForFailure: () => Promise<unknown>;
  exited: () => boolean;
  interceptSignals: (fault: SignalFault) => void;
  release: () => void;
  assertGroupAbsent: () => void;
};

const testNodeExecPath = resolveTestNodeExecPath();

async function withNativeBoundedFixture(
  context: Pick<TestContext, "signal" | "onTestFinished">,
  options: { source: string; bufferOutputUntilExit?: boolean },
  verify: (fixture: NativeBoundedFixture) => Promise<void>,
): Promise<void> {
  const lifetime = createFixtureLifetime();
  const finished = new AbortController();
  const signal = AbortSignal.any([context.signal, finished.signal]);
  const originalKill = process.kill.bind(process);
  context.onTestFinished(async () => {
    finished.abort();
    await lifetime.cleanup();
  });

  const fixture = await lifetime.acquire(async (rejectAfterCleanup) => {
    signal.throwIfAborted();
    const root = lifetime.createTempDir("ios-keychain-signal-fixture-");
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
    let outcome: Promise<Outcome>;
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
    const child = observed.find(
      (candidate) =>
        candidate.spawnargs[0] === testNodeExecPath && candidate.spawnargs[1] === script,
    );
    if (!child) {
      // Unknown process ownership cannot certify cleanup or release the root.
      return rejectAfterCleanup(new Error("Expected the exact native fixture child"), async () => {
        throw new Error("Native fixture child identity was not captured");
      });
    }
    let childClosed = false;
    let childExited = false;
    let groupRetired = false;
    let fault: SignalFault | undefined;
    let restoreSignalObserver = () => {};
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => {
        childClosed = true;
        resolve();
      });
    });
    const groupAbsent = (toleratePermission = false) => {
      const pid = child.pid;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) {
        throw new Error("Native fixture did not acquire a process group");
      }
      try {
        originalKill(-pid, 0);
      } catch (error) {
        if (hasErrnoCode(error, "ESRCH")) {
          return (groupRetired = true);
        }
        if (!toleratePermission || !hasErrnoCode(error, "EPERM")) {
          throw error;
        }
      }
      return false;
    };
    const cleanup = async () => {
      finished.abort();
      fault = undefined;
      try {
        // These fixtures never fork; exact-child close reaps their only process.
        if (!childClosed) {
          child.kill("SIGKILL");
        }
        await closed;
        if (!groupRetired && !groupAbsent(true)) {
          throw new Error("Native fixture group exit was not confirmed");
        }
        await outcome;
      } finally {
        restoreSignalObserver();
      }
    };
    try {
      if (options.bufferOutputUntilExit) {
        child.stdout?.pause();
      }
      child.once("exit", () => {
        childExited = true;
        if (options.bufferOutputUntilExit) {
          child.stdout?.resume();
        }
      });
      const pid = child.pid;
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
            if (!groupAbsent(true)) {
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
      return {
        cleanup,
        waitForFailure: async () => {
          const result = await racePromiseWithAbortSignal(outcome, signal);
          expect(result.status).toBe("rejected");
          if (result.status !== "rejected") {
            throw new Error("Expected bounded command rejection");
          }
          return result.reason;
        },
        exited: () => childExited,
        interceptSignals: (next: SignalFault) => {
          signal.throwIfAborted();
          fault = next;
        },
        release: () => {
          signal.throwIfAborted();
          fs.writeFileSync(gate, "exit\n");
        },
        assertGroupAbsent: () => {
          if (!groupAbsent()) {
            throw new Error("Native fixture group still exists");
          }
        },
      };
    } catch (error) {
      return rejectAfterCleanup(error, cleanup);
    }
  });
  try {
    await lifetime.run(async () => {
      signal.throwIfAborted();
      await verify(fixture);
    });
  } finally {
    await fixture.cleanup();
  }
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
        expect(await fixture.waitForFailure()).toMatchObject({
          message: expect.stringContaining(
            persistent
              ? "owned process group did not terminate"
              : "exceeded the 4096-byte output limit",
          ),
          ...(persistent ? { cause: permission } : {}),
        });
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
        expect(await fixture.waitForFailure()).toMatchObject({
          message: expect.stringContaining("exceeded the 4096-byte output limit"),
        });
        expect({ exitedBeforeSignal, permissionFaults }).toEqual({
          exitedBeforeSignal: true,
          permissionFaults: 1,
        });
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
      expect(await fixture.waitForFailure()).toBe(ioFailure);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      fixture.assertGroupAbsent();
    });
  });
}
