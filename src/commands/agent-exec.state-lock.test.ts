import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  recordAgentCleanupFailure,
  createAgentCleanupScope,
} from "../agents/run-cleanup-timeout.js";
import { acquireGatewayLock, type GatewayLockOptions } from "../infra/gateway-lock.js";
import * as childAdapter from "../process/supervisor/adapters/child.js";
import { createProcessAdapterEvents } from "../process/supervisor/adapters/process-events.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { createStubChildAdapter } from "../process/supervisor/supervisor.test-support.js";
import type { ProcessExtinctionResult } from "../process/supervisor/types.js";
import { agentExecCommand } from "./agent-exec.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function successResult() {
  return {
    payloads: [{ text: "done" }],
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: "session-result", provider: "openai", model: "gpt-5.6-sol" },
    },
  };
}

function createGatewayLockOptions(
  stateDir: string,
  overrides: Partial<GatewayLockOptions> = {},
): GatewayLockOptions {
  return {
    allowInTests: true,
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
    lockDir: path.join(stateDir, "gateway-locks"),
    timeoutMs: 100,
    ...overrides,
  };
}

function createSignalProcess() {
  type SignalName = "SIGINT" | "SIGTERM";
  const listeners = new Map<SignalName, Set<() => void>>();
  const processLike = {
    on(signal: SignalName, handler: () => void) {
      const current = listeners.get(signal) ?? new Set<() => void>();
      current.add(handler);
      listeners.set(signal, current);
      return processLike;
    },
    off(signal: SignalName, handler: () => void) {
      listeners.get(signal)?.delete(handler);
      return processLike;
    },
  };
  return {
    processLike,
    emit(signal: SignalName) {
      for (const handler of listeners.get(signal) ?? []) {
        handler();
      }
    },
  };
}

describe("agent exec retained-state ownership", () => {
  it.each(
    (["job-unavailable", "job-create-failed"] as const).flatMap((reason) =>
      [false, true].map((retained) => ({ reason, retained })),
    ),
  )(
    "retains state after $reason certification (retained=$retained)",
    async ({ reason, retained }) => {
      const root = tempDirs.make("openclaw-agent-exec-uncertain-extinction-");
      const lockOptions = createGatewayLockOptions(root);
      const certification: ProcessExtinctionResult =
        reason === "job-unavailable"
          ? { status: "uncertain", reason }
          : { status: "uncertain", reason, cause: new Error("Job creation failed") };
      const adapter = Object.assign(createStubChildAdapter(), createProcessAdapterEvents(), {
        waitForExtinction: async () => certification,
      });
      const spawnAdapter = vi.spyOn(childAdapter, "createChildAdapter").mockResolvedValueOnce({
        adapter,
        ready: Promise.resolve(),
      });
      let runStateDir: string | undefined;
      try {
        const result = await agentExecCommand(
          "inspect",
          retained ? { stateDir: root } : {},
          createTestRuntime(),
          {
            maxToolCalls: 1,
            gatewayLockOptions: lockOptions,
            runAgent: async (opts) => {
              runStateDir = process.env.OPENCLAW_STATE_DIR;
              if (!runStateDir) {
                throw new Error("Expected the command's state directory");
              }
              await fs.writeFile(path.join(runStateDir, "owned-work"), "still owned");
              const run = await getProcessSupervisor().spawn({
                mode: "child",
                argv: [process.execPath, "-e", ""],
                scopeKey: String(opts.sessionKey),
              });
              adapter.settle(0);
              await run.wait();
              await expect(run.waitForExtinction?.()).resolves.toEqual(certification);
              return successResult();
            },
          },
        );
        expect.soft(result.exitCode).toBe(1);
        expect.soft(result.envelope.error?.message).toContain(reason);
        expect(runStateDir).toBeDefined();
        await expect
          .soft(fs.readFile(path.join(runStateDir!, "owned-work"), "utf8"))
          .resolves.toBe("still owned");
        if (retained) {
          await expect
            .soft(
              fs
                .readFile(path.join(lockOptions.lockDir!, "gateway.state.lock"), "utf8")
                .then((value) => JSON.parse(value)),
            )
            .resolves.toMatchObject({ pid: process.pid, role: "agent-embedded" });
        }
      } finally {
        spawnAdapter.mockRestore();
        if (!retained && runStateDir) {
          await fs.rm(runStateDir, { recursive: true, force: true });
        }
      }
    },
  );

  it.each([false, true])(
    "retains state after uncertain runtime cleanup (retained=%s)",
    async (retained) => {
      const root = tempDirs.make("openclaw-agent-exec-uncertain-cleanup-");
      const lockOptions = createGatewayLockOptions(root);
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      const cleanupScope = createAgentCleanupScope();
      let runStateDir: string | undefined;
      try {
        const result = await cleanupScope.run(() =>
          agentExecCommand("inspect", retained ? { stateDir: root } : {}, createTestRuntime(), {
            gatewayLockOptions: lockOptions,
            runAgent: async () => {
              runStateDir = process.env.OPENCLAW_STATE_DIR;
              if (!runStateDir) {
                throw new Error("Expected the command's state directory");
              }
              await fs.writeFile(path.join(runStateDir, "owned-work"), "still owned");
              recordAgentCleanupFailure();
              return successResult();
            },
          }),
        );
        expect.soft(result.exitCode).toBe(1);
        expect.soft(cleanupScope.outcome).toBe("uncertain");
        expect.soft(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
        expect(runStateDir).toBeDefined();
        await expect(fs.readFile(path.join(runStateDir!, "owned-work"), "utf8")).resolves.toBe(
          "still owned",
        );
        if (retained) {
          const owner = JSON.parse(
            await fs.readFile(path.join(lockOptions.lockDir!, "gateway.state.lock"), "utf8"),
          );
          expect(owner).toMatchObject({ pid: process.pid, role: "agent-embedded" });
        }
      } finally {
        if (!retained && runStateDir) {
          await fs.rm(runStateDir, { recursive: true, force: true });
        }
      }
    },
  );

  it("refuses a state directory owned by a live Gateway", async () => {
    const stateDir = tempDirs.make("openclaw-agent-exec-gateway-owner-");
    const lockOptions = createGatewayLockOptions(stateDir, {
      readProcessStartTime: () => 123_456,
    });
    const gatewayLock = await acquireGatewayLock({ ...lockOptions, port: 28789 });
    expect(gatewayLock).not.toBeNull();
    if (!gatewayLock) {
      throw new Error("Expected live Gateway fixture lock");
    }
    const runAgent = vi.fn(async () => successResult());
    const runtime = createTestRuntime();
    const { error } = runtime;

    try {
      const result = await agentExecCommand("inspect", { stateDir }, runtime, {
        gatewayLockOptions: lockOptions,
        runAgent,
      });
      expect(result.exitCode).toBe(1);
      expect(runAgent).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        `A Gateway is running for this state directory (pid ${process.pid}, port 28789). Omit --state-dir to use isolated temporary state, or stop the Gateway first (openclaw gateway stop).`,
      );
    } finally {
      await gatewayLock.release();
    }
  });

  it("holds and releases the embedded state lock around the run", async () => {
    const stateDir = tempDirs.make("openclaw-agent-exec-lock-owner-");
    const lockOptions = createGatewayLockOptions(stateDir);
    const stateLockPath = path.join(lockOptions.lockDir!, "gateway.state.lock");

    await agentExecCommand("inspect", { stateDir }, createTestRuntime(), {
      gatewayLockOptions: lockOptions,
      runAgent: vi.fn(async () => {
        const payload = JSON.parse(await fs.readFile(stateLockPath, "utf8")) as {
          pid?: number;
          role?: string;
        };
        expect(payload).toMatchObject({ pid: process.pid, role: "agent-embedded" });
        return successResult();
      }),
    });

    await expect(fs.stat(stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases the embedded state lock when SIGTERM aborts the run", async () => {
    const stateDir = tempDirs.make("openclaw-agent-exec-signal-owner-");
    const lockOptions = createGatewayLockOptions(stateDir);
    const stateLockPath = path.join(lockOptions.lockDir!, "gateway.state.lock");
    const signals = createSignalProcess();
    const runtime = createTestRuntime();
    const runAgent = vi.fn(async (opts: Record<string, unknown>) => {
      const signal = opts.abortSignal as AbortSignal;
      return await new Promise<ReturnType<typeof successResult>>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("agent exec aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    });

    const run = agentExecCommand("inspect", { stateDir }, runtime, {
      gatewayLockOptions: lockOptions,
      process: signals.processLike,
      runAgent,
    });
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledOnce());
    signals.emit("SIGTERM");
    await run;

    await expect(fs.stat(stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(runtime.exit).toHaveBeenCalledWith(143, { resetStream: process.stderr });
  });
});
