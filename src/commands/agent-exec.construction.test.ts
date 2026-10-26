import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { isProcessAlive, waitForDead } from "../../test/helpers/process-wait.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import * as cliBackends from "../plugins/cli-backends.runtime.js";
import * as processSupervisor from "../process/supervisor/index.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { SpawnInput } from "../process/supervisor/types.js";
import { agentExecCommand } from "./agent-exec.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("bounds blocked private-input construction through the shipped CLI command", async ({
  signal,
  onTestFinished,
}) => {
  const receipts = await openFixtureReceiptChannel();
  onTestFinished(() => receipts.close());
  const root = tempDirs.make("openclaw-agent-exec-service-construction-");
  const pidPath = path.join(root, "command.pid");
  const configPath = path.join(root, "openclaw.json");
  const createSecretData = vi.fn(() => Buffer.alloc(8 * 1024 * 1024, 97));
  // An unread secret pipe blocks construction through the real supervisor route.
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
          // Freeze after cold preparation; wait for readiness before advancing time.
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
      tools: { fs: { workspaceOnly: false } },
      agents: {
        defaults: { model: { primary: "construction-cli/model-a" }, thinkingDefault: "off" },
      },
    }),
    "utf8",
  );

  vi.stubEnv("NODE_DISABLE_COMPILE_CACHE", "1");
  vi.stubEnv("OPENCLAW_SERVICE_MARKER", "openclaw");
  // Keep expected POSIX cleanup uncertainty out of the shared supervisor.
  const supervisor = createProcessSupervisor();
  vi.spyOn(processSupervisor, "getProcessSupervisor").mockReturnValue(supervisor);
  const spawn = supervisor.spawn.bind(supervisor);
  const admitted = createDeferred<SpawnInput>();
  let pendingRun: ReturnType<typeof spawn> | undefined;
  vi.spyOn(supervisor, "spawn").mockImplementation((input) => {
    pendingRun = spawn(input);
    admitted.resolve(input);
    return pendingRun;
  });
  const result = agentExecCommand(
    "probe",
    { config: configPath, cwd: root, timeout: "1", json: true },
    createTestRuntime(),
  );
  let commandPid: number | undefined;
  let input: SpawnInput | undefined;
  try {
    input = await withinTest(
      Promise.race([
        admitted.promise,
        result.then((finished) => {
          throw new Error(`Command ended before supervisor admission: ${JSON.stringify(finished)}`);
        }),
      ]),
      signal,
    );
    // The PID precedes its receipt, so it decides readiness after result settlement.
    const requirePid = async (error: unknown = new Error(`No PID: ${pidPath}`)) => {
      const pid = await fs.readFile(pidPath, "utf8").catch((readError: unknown) => {
        if (!hasErrnoCode(readError, "ENOENT")) {
          throw readError;
        }
      });
      if (!pid) {
        throw error;
      }
    };
    const operationSettled = result.then(() => requirePid(), requirePid);
    await withinTest(Promise.race([receipts.waitFor(pidPath, "ready"), operationSettled]), signal);
    commandPid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
    expect(isProcessAlive(commandPid)).toBe(true);
    expect(createSecretData).toHaveBeenCalledOnce();
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
    await processRun;
    vi.useRealTimers();
    const completed = await result;
    await waitForDead(commandPid, signal);
    expect(completed).toMatchObject({ exitCode: 2, envelope: { ok: false, status: "timeout" } });
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
});
