import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as realDelay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type FixtureReceiptChannel,
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { isProcessAlive } from "../../test/helpers/process-wait.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import * as cliBackends from "../plugins/cli-backends.runtime.js";
import * as processSupervisor from "../process/supervisor/index.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { SpawnInput } from "../process/supervisor/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { agentExecCommand } from "./agent-exec.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

// Failed relay cleanup has no extinction promise for the command's foreign PID.
async function waitForCommandExit(pid: number, signal: AbortSignal): Promise<void> {
  await withinTest(
    (async () => {
      while (isProcessAlive(pid)) {
        await realDelay(5, undefined, { signal });
      }
    })(),
    signal,
  ).catch((error: unknown) => {
    throw new Error(`process still alive: ${pid}`, { cause: error });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("agent exec command composition", () => {
  it("bounds blocked private-input construction through the shipped CLI command", async ({
    signal,
  }) => {
    const root = tempDirs.make("openclaw-agent-exec-service-construction-");
    const pidPath = path.join(root, "command.pid");
    const configPath = path.join(root, "openclaw.json");
    const createSecretData = vi.fn(() => Buffer.alloc(8 * 1024 * 1024, 97));
    // Claude's plugin-owned SDK bypasses the supervisor. A registered process backend
    // keeps the real command route and blocks construction on an unread secret pipe.
    vi.spyOn(cliBackends, "resolveRuntimeCliBackends").mockReturnValue([
      {
        id: "construction-cli",
        pluginId: "construction-test",
        config: {
          command: process.execPath,
          args: [
            "--input-type=module",
            "-e",
            `${fixtureReceiptClientSource(receipts.endpoint)}
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
sendReceipt(${JSON.stringify(pidPath)}, "ready");
setInterval(() => {}, 1000);`,
          ],
          input: "stdin",
          output: "text",
        },
        prepareExecution: () => ({
          beforeExecution: async () => {
            // Freeze at the backend's queue admission, after cold command preparation.
            // Real process readiness must precede advancing the construction deadline.
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          },
          secretInput: {
            fd: 3,
            fingerprint: "synthetic-construction",
            createData: createSecretData,
          },
        }),
      },
    ]);
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          defaults: {
            model: { primary: "construction-cli/model-a" },
            // The synthetic backend has no reasoning capability to discover.
            thinkingDefault: "off",
          },
        },
      }),
      "utf8",
    );

    const completed = await withEnvAsync(
      {
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_SERVICE_MARKER: "openclaw",
      },
      async () => {
        const runtime = createTestRuntime();
        // POSIX relay cancellation loses cleanup identity. Keep that failed owner
        // local so shared-worker teardown cannot inherit its expected uncertainty.
        const supervisor = createProcessSupervisor();
        vi.spyOn(processSupervisor, "getProcessSupervisor").mockReturnValue(supervisor);
        const spawn = supervisor.spawn.bind(supervisor);
        const admitted = createDeferred<SpawnInput>();
        let pendingRun: ReturnType<typeof spawn> | undefined;
        vi.spyOn(supervisor, "spawn").mockImplementation((input) => {
          const pending = spawn(input);
          pendingRun = pending;
          admitted.resolve(input);
          return pending;
        });
        const result = agentExecCommand(
          "probe",
          { config: configPath, cwd: root, timeout: "1", json: true },
          runtime,
        );
        let commandPid: number | undefined;
        let input: SpawnInput | undefined;
        try {
          input = await withinTest(
            Promise.race([
              admitted.promise,
              result.then((finished) => {
                throw new Error(
                  `Command ended before supervisor admission: ${JSON.stringify(finished)}`,
                );
              }),
            ]),
            signal,
          );
          // The side-channel receipt can arrive after result settlement. The fixture writes
          // its PID first, so the durable record decides that race without another deadline.
          const readPid = () =>
            fs.readFile(pidPath, "utf8").catch((error: unknown) => {
              if (hasErrnoCode(error, "ENOENT")) {
                return "";
              }
              throw error;
            });
          const operationSettled = result.then(
            async () => {
              if (!(await readPid())) {
                throw new Error(`timeout waiting for pid in ${pidPath}`);
              }
            },
            async (error: unknown) => {
              if (!(await readPid())) {
                throw error;
              }
            },
          );
          await withinTest(
            Promise.race([receipts.waitFor(pidPath, "ready"), operationSettled]),
            signal,
          );
          commandPid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
          expect(isProcessAlive(commandPid)).toBe(true);
          expect(createSecretData).toHaveBeenCalledOnce();
          expect(input).toMatchObject({ mode: "child" });
          const remainingMs = expectDefined(input.timeoutMs, "remaining construction deadline");
          expect(remainingMs).toBeGreaterThan(0);
          expect(remainingMs).toBeLessThanOrEqual(1_000);
          const processRun = expectDefined(pendingRun, "admitted supervisor process");
          const settled = vi.fn();
          void processRun.then(settled, settled);
          await vi.advanceTimersByTimeAsync(remainingMs - 1);
          expect(settled).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          // Let the deferred construction deadline decide before awaiting startup settlement.
          await vi.advanceTimersToNextTimerAsync();
          const managed = await processRun;
          await expect(managed.wait()).resolves.toMatchObject({ reason: "overall-timeout" });
          expect(managed.activity.resultSettled).toBe(true);
          vi.useRealTimers();
          const finished = await result;
          await waitForCommandExit(commandPid, signal);
          return finished;
        } finally {
          vi.useRealTimers();
          if (input?.runId) {
            supervisor.cancel(input.runId);
          }
          if (commandPid && isProcessAlive(commandPid)) {
            process.kill(commandPid, "SIGKILL");
          }
          await result;
          const cleanup = supervisor.shutdown();
          // Windows uses a direct child; only POSIX loses the relay's cleanup authority.
          if (process.platform === "win32") {
            await expect(cleanup).resolves.toBeUndefined();
          } else {
            await expect(cleanup).rejects.toThrow("service child cleanup identity lost");
          }
        }
      },
    );
    expect(completed.exitCode).toBe(2);
    expect(completed.envelope).toMatchObject({
      ok: false,
      status: "timeout",
    });
  });
});
