import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  recordAgentCleanupFailure,
  createAgentCleanupScope,
} from "../agents/run-cleanup-timeout.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import * as childAdapter from "../process/supervisor/adapters/child.js";
import { createProcessAdapterEvents } from "../process/supervisor/adapters/process-events.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { createStubChildAdapter } from "../process/supervisor/supervisor.test-support.js";
import type { ProcessExtinctionResult } from "../process/supervisor/types.js";
import { agentExecCommand } from "./agent-exec.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const success = () => ({ payloads: [{ text: "done" }], meta: { durationMs: 1 } });
function stateFixture() {
  const stateDir = tempDirs.make("openclaw-agent-exec-lock-");
  const lockDir = path.join(stateDir, "gateway-locks");
  const lockOptions = {
    allowInTests: true,
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
    lockDir,
    timeoutMs: 100,
  };
  return { stateDir, lockOptions, lockPath: path.join(lockDir, "gateway.state.lock") };
}
async function expectLock(lockPath: string) {
  expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toMatchObject({
    pid: process.pid,
    role: "agent-embedded",
  });
}

describe("agent exec retained-state ownership", () => {
  it("retains the state lock after uncertain process extinction", async () => {
    const { stateDir, lockOptions, lockPath } = stateFixture();
    const certification: ProcessExtinctionResult = {
      status: "uncertain",
      reason: "job-unavailable",
    };
    const adapter = Object.assign(createStubChildAdapter(), createProcessAdapterEvents(), {
      waitForExtinction: async () => certification,
    });
    const spawnAdapter = vi
      .spyOn(childAdapter, "createChildAdapter")
      .mockResolvedValueOnce({ adapter, ready: Promise.resolve() });
    try {
      const result = await agentExecCommand("inspect", { stateDir }, createTestRuntime(), {
        maxToolCalls: 1,
        gatewayLockOptions: lockOptions,
        runAgent: async (opts) => {
          expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
          await fs.writeFile(path.join(stateDir, "owned-work"), "still owned");
          const run = await getProcessSupervisor().spawn({
            mode: "child",
            argv: [process.execPath, "-e", ""],
            scopeKey: String(opts.sessionKey),
          });
          adapter.settle(0);
          await run.wait();
          await expect(run.waitForExtinction?.()).resolves.toEqual(certification);
          return success();
        },
      });
      expect(result.exitCode).toBe(1);
      expect(result.envelope.error?.message).toContain("job-unavailable");
      await expect(fs.readFile(path.join(stateDir, "owned-work"), "utf8")).resolves.toBe(
        "still owned",
      );
      await expectLock(lockPath);
    } finally {
      spawnAdapter.mockRestore();
    }
  });

  it("preserves temporary state after uncertain runtime cleanup", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const cleanupScope = createAgentCleanupScope();
    let stateDir = "";
    try {
      const result = await cleanupScope.run(() =>
        agentExecCommand("inspect", {}, createTestRuntime(), {
          runAgent: async () => {
            stateDir = process.env.OPENCLAW_STATE_DIR!;
            await fs.writeFile(path.join(stateDir, "owned-work"), "still owned");
            recordAgentCleanupFailure();
            return success();
          },
        }),
      );
      expect(result.exitCode).toBe(1);
      expect(cleanupScope.outcome).toBe("uncertain");
      expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
      await expect(fs.readFile(path.join(stateDir, "owned-work"), "utf8")).resolves.toBe(
        "still owned",
      );
    } finally {
      if (stateDir) {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    }
  });

  it("refuses a state directory owned by a live Gateway", async () => {
    const { stateDir, lockOptions } = stateFixture();
    const options = { ...lockOptions, readProcessStartTime: () => 123_456 };
    const gatewayLock = await acquireGatewayLock({ ...options, port: 28789 });
    if (!gatewayLock) {
      throw new Error("Expected live Gateway fixture lock");
    }
    const runAgent = vi.fn(async () => success());
    const runtime = createTestRuntime();
    try {
      const result = await agentExecCommand("inspect", { stateDir }, runtime, {
        gatewayLockOptions: options,
        runAgent,
      });
      expect(result.exitCode).toBe(1);
      expect(runAgent).not.toHaveBeenCalled();
      expect(runtime.error).toHaveBeenCalledWith(
        `A Gateway is running for this state directory (pid ${process.pid}, port 28789). Omit --state-dir to use isolated temporary state, or stop the Gateway first (openclaw gateway stop).`,
      );
    } finally {
      await gatewayLock.release();
    }
  });

  it("holds and releases the embedded state lock around the run", async () => {
    const { stateDir, lockOptions, lockPath } = stateFixture();
    await fs.writeFile(path.join(stateDir, "keep.txt"), "keep");
    const result = await agentExecCommand("inspect", { stateDir }, createTestRuntime(), {
      gatewayLockOptions: lockOptions,
      runAgent: async () => {
        await expectLock(lockPath);
        return success();
      },
    });
    expect(result.exitCode).toBe(0);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(stateDir, "keep.txt"), "utf8")).resolves.toBe("keep");
    expect((await fs.readdir(stateDir)).toSorted()).toEqual(["gateway-locks", "keep.txt", "tmp"]);
  });

  it("releases the embedded state lock when SIGTERM aborts the run", async () => {
    const { stateDir, lockOptions, lockPath } = stateFixture();
    const signals = new EventEmitter();
    const entered = createDeferred();
    const runtime = createTestRuntime();
    const run = agentExecCommand("inspect", { stateDir }, runtime, {
      gatewayLockOptions: lockOptions,
      process: signals,
      runAgent: async (opts) => {
        const signal = opts.abortSignal as AbortSignal;
        const pending = new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("agent exec aborted"), { name: "AbortError" })),
            { once: true },
          );
        });
        entered.resolve();
        return pending;
      },
    });
    await Promise.race([
      entered.promise,
      run.then(() => {
        throw new Error("Run ended before signal admission");
      }),
    ]);
    signals.emit("SIGTERM");
    await run;
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(runtime.exit).toHaveBeenCalledWith(143, { resetStream: process.stderr });
  });
});
