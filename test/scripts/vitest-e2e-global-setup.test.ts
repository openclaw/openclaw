import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectManagedProcessGroup } from "../../scripts/lib/managed-child-process.mts";
import { runE2eGlobalSetup } from "../../scripts/lib/vitest-build-prerequisites.mts";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mjs";
import { forwardSignalToVitestProcessGroup } from "../../scripts/vitest-process-group.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { killPidIfAlive } from "../../src/test-utils/process-tree.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";

type SetupCommandRunner = NonNullable<Parameters<typeof runE2eGlobalSetup>[0]>;

const posixIt = process.platform === "win32" ? it.skip : it;
// The runner closes independently of the descendants signaled through its group.
async function waitForProcessCleanup(
  predicate: () => boolean,
  description: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    while (!predicate()) {
      await waitForProcessTick(10, undefined, { signal });
    }
  } catch (cause) {
    throw new Error(description, { cause });
  }
}

function readFixturePid(file: string): number {
  const pid = Number(fs.readFileSync(file, "utf8"));
  expect(Number.isInteger(pid) && pid > 0, `invalid fixture PID in ${file}`).toBe(true);
  return pid;
}

describe("vitest E2E global setup", () => {
  beforeEach(() => {
    // CI's prebuilt runtime must not skip this fixture's modeled build commands.
    vi.stubEnv("OPENCLAW_E2E_SKIP_BUILD", undefined);
    vi.stubEnv("OPENCLAW_E2E_USE_PREBUILT_DIST", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("runs both build commands sequentially with their exact environments", async () => {
    let resolveFirstCommand!: (status: number) => void;
    const firstCommand = new Promise<number>((resolve) => {
      resolveFirstCommand = resolve;
    });
    const runCommand = vi
      .fn<SetupCommandRunner>()
      .mockImplementationOnce(() => firstCommand)
      .mockResolvedValueOnce(0);

    const setupPromise = runE2eGlobalSetup(runCommand);
    expect(runCommand).toHaveBeenCalledTimes(1);
    resolveFirstCommand(0);
    await setupPromise;
    expect(runCommand.mock.calls).toEqual([
      [
        ["scripts/prepare-vitest-runtime.mjs"],
        {
          ...process.env,
          OPENCLAW_BUILD_PRIVATE_QA: "1",
          OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
        },
      ],
      [
        ["--import", "tsx", "scripts/tsdown-build.mts", "--config", "tsdown.ai.config.ts"],
        process.env,
      ],
    ]);
  });

  it("propagates a nonzero command status", async () => {
    const runCommand = vi
      .fn<SetupCommandRunner>()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(23);
    await expect(runE2eGlobalSetup(runCommand)).rejects.toThrow(
      "E2E setup command failed with exit code 23: --import tsx scripts/tsdown-build.mts --config tsdown.ai.config.ts",
    );
  });

  it.each(["OPENCLAW_E2E_SKIP_BUILD", "OPENCLAW_E2E_USE_PREBUILT_DIST"] as const)(
    "skips rebuilding when %s is set",
    async (envName) => {
      const runCommand = vi.fn<SetupCommandRunner>();

      await runE2eGlobalSetup(runCommand, { [envName]: "1" });

      expect(runCommand).not.toHaveBeenCalled();
    },
  );

  posixIt("forwards output and SIGTERM through the runner process group", async ({ signal }) => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-setup-group-"));
    const fixturePath = path.join(fixtureDir, "scripts", "prepare-vitest-runtime.mjs");
    const pidPaths = ["child.pid", "descendant.pid"].map((name) => path.join(fixtureDir, name));
    let cleanup = async () => fs.rmSync(fixtureDir, { force: true, recursive: true });
    await runQaGatewayFixture(
      async () => {
        fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
        fs.writeFileSync(
          fixturePath,
          `import { spawn } from "node:child_process";
import fs from "node:fs";
function writePid(file, pid) {
  fs.writeFileSync(file + ".tmp", String(pid));
  fs.renameSync(file + ".tmp", file);
}
process.stdin.once("data", () => {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writePid(${JSON.stringify(pidPaths[0])}, process.pid);
  writePid(${JSON.stringify(pidPaths[1])}, descendant.pid);
  process.stdout.write("setup-stdout\\n");
  process.stderr.write("setup-stderr\\n");
  setInterval(() => {}, 1000);
});
process.stdin.resume();
`,
        );
        const setupUrl = resolveRuntimeWorkerUrl(scriptModuleEntrypoints.vitestBuildPrerequisites);
        const runnerScript = `import { runE2eGlobalSetup } from ${JSON.stringify(setupUrl.href)};
process.chdir(${JSON.stringify(fixtureDir)});
await runE2eGlobalSetup(undefined, process.env);`;
        const runner = spawn(
          process.execPath,
          [
            ...resolveRuntimeWorkerArgv(setupUrl).slice(0, -1),
            "--input-type=module",
            "--eval",
            runnerScript,
          ],
          { detached: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            runner.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
          },
        );
        const pids: number[] = [];
        cleanup = () =>
          runQaGatewayFixture(
            async () => {
              if (!runner.pid) {
                return;
              }
              try {
                process.kill(-runner.pid, "SIGKILL");
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                  throw error;
                }
              }
            },
            () => killPidIfAlive(runner.pid),
            ...pidPaths.map((file) => async () => {
              if (!fs.existsSync(file)) {
                return;
              }
              const pid = readFixturePid(file);
              killPidIfAlive(pid);
            }),
            async () => {
              // Keep PID evidence unless every process and its output have finished.
              await runQaGatewayFixture(
                async () => {
                  await closed;
                },
                async () => {
                  if (!runner.pid) {
                    return;
                  }
                  await waitForProcessCleanup(
                    () =>
                      inspectManagedProcessGroup(runner, { errorPolicy: "indeterminate" }) ===
                      "dead",
                    `runner group still alive; retained fixture: ${fixtureDir}`,
                    signal,
                  );
                  expect(
                    inspectManagedProcessGroup(runner, { errorPolicy: "indeterminate" }),
                    `retained fixture: ${fixtureDir}`,
                  ).toBe("dead");
                },
              );
              fs.rmSync(fixtureDir, { force: true, recursive: true });
            },
          );
        let stdout = "";
        let stderr = "";
        const stdoutReady = createDeferred();
        const stderrReady = createDeferred();
        runner.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes("setup-stdout")) {
            stdoutReady.resolve();
          }
        });
        runner.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
          if (stderr.includes("setup-stderr")) {
            stderrReady.resolve();
          }
        });
        await withinTest(once(runner, "spawn"), signal);
        runner.stdin.write("start\n");
        await withinTest(
          awaitGateBeforeSettlement(
            Promise.all([stdoutReady.promise, stderrReady.promise]),
            closed,
            `timeout waiting for pid in ${pidPaths[0]}`,
          ),
          signal,
        );
        // Both PID writes precede setup-stdout in the fixture, which the runner forwards.
        pids.push(...pidPaths.map(readFixturePid));
        expect(stdout).toContain("setup-stdout");
        expect(stderr).toContain("setup-stderr");
        expect(
          forwardSignalToVitestProcessGroup({
            child: runner,
            kill: process.kill.bind(process),
            signal: "SIGTERM",
          }),
        ).toBe(true);
        await expect(withinTest(closed, signal)).resolves.toEqual({
          code: null,
          signal: "SIGTERM",
        });
        await waitForProcessCleanup(
          () => pids.every((pid) => !isProcessAlive(pid)),
          `process still alive: ${pids.join(", ")}`,
          signal,
        );
      },
      () => cleanup(),
    );
  });
});
