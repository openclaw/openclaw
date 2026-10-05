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
import * as embeddedStateLock from "../infra/embedded-state-lock.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { runAgentExecWithMock } from "./agent-exec.test-helpers.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const acquireStateLock = embeddedStateLock.acquireEmbeddedStateLock;
const createSignalBridge = embeddedStateLock.createEmbeddedStateSignalBridge;
afterEach(() => vi.restoreAllMocks());
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
    readProcessStartTime: () => 123_456,
  };
  vi.spyOn(embeddedStateLock, "acquireEmbeddedStateLock").mockImplementation((params) =>
    acquireStateLock({ ...params, options: lockOptions }),
  );
  return { stateDir, lockOptions, lockPath: path.join(lockDir, "gateway.state.lock") };
}
async function expectLock(lockPath: string) {
  expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toMatchObject({
    pid: process.pid,
    role: "agent-embedded",
  });
}

describe("agent exec retained-state ownership", () => {
  it.each([false, true])(
    "preserves state after uncertain runtime cleanup (retained: %s)",
    async (retained) => {
      const fixture = retained ? stateFixture() : undefined;
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      const cleanupScope = createAgentCleanupScope();
      let stateDir = "";
      try {
        const result = await cleanupScope.run(() =>
          runAgentExecWithMock(
            "inspect",
            fixture ? { stateDir: fixture.stateDir } : {},
            createTestRuntime(),
            async () => {
              stateDir = process.env.OPENCLAW_STATE_DIR!;
              await fs.writeFile(path.join(stateDir, "owned-work"), "still owned");
              recordAgentCleanupFailure();
              return success();
            },
          ),
        );
        expect(result.exitCode).toBe(1);
        expect(cleanupScope.outcome).toBe("uncertain");
        expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
        if (fixture) {
          await expectLock(fixture.lockPath);
        }
        await expect(fs.readFile(path.join(stateDir, "owned-work"), "utf8")).resolves.toBe(
          "still owned",
        );
      } finally {
        if (stateDir) {
          await fs.rm(stateDir, { recursive: true, force: true });
        }
      }
    },
  );

  it("refuses a state directory owned by a live Gateway", async () => {
    const { stateDir, lockOptions } = stateFixture();
    const gatewayLock = await acquireGatewayLock({ ...lockOptions, port: 28789 });
    if (!gatewayLock) {
      throw new Error("Expected live Gateway fixture lock");
    }
    const runAgent = vi.fn(async () => success());
    const runtime = createTestRuntime();
    try {
      const result = await runAgentExecWithMock("inspect", { stateDir }, runtime, runAgent);
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
    const { stateDir, lockPath } = stateFixture();
    await fs.writeFile(path.join(stateDir, "keep.txt"), "keep");
    const result = await runAgentExecWithMock(
      "inspect",
      { stateDir },
      createTestRuntime(),
      async () => {
        await expectLock(lockPath);
        return success();
      },
    );
    expect(result.exitCode).toBe(0);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(stateDir, "keep.txt"), "utf8")).resolves.toBe("keep");
    expect((await fs.readdir(stateDir)).toSorted()).toEqual(["gateway-locks", "keep.txt", "tmp"]);
  });

  it("releases the embedded state lock when SIGTERM aborts the run", async () => {
    const { stateDir, lockPath } = stateFixture();
    const signals = new EventEmitter();
    const entered = createDeferred();
    const runtime = createTestRuntime();
    vi.spyOn(embeddedStateLock, "createEmbeddedStateSignalBridge").mockImplementation(() =>
      createSignalBridge(signals),
    );
    const run = runAgentExecWithMock("inspect", { stateDir }, runtime, async (opts) => {
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
