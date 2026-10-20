import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inspectManagedProcessGroup } from "../../scripts/lib/managed-child-process.mts";
import { runE2eGlobalSetup } from "../../scripts/lib/vitest-build-prerequisites.mts";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mjs";
import {
  forceKillVitestProcessGroup,
  forwardSignalToVitestProcessGroup,
} from "../../scripts/vitest-process-group.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { killPidIfAlive } from "../../src/test-utils/process-tree.js";
import { waitForDead } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";

type SetupCommandRunner = NonNullable<Parameters<typeof runE2eGlobalSetup>[0]>;
type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };

const posixIt = process.platform === "win32" ? it.skip : it;
const aiBuild = ["--import", "tsx", "scripts/tsdown-build.mts", "--config", "tsdown.ai.config.ts"];

function readFixturePid(file: string): number {
  const pid = Number(fs.readFileSync(file, "utf8"));
  expect(Number.isInteger(pid) && pid > 0, `invalid fixture PID in ${file}`).toBe(true);
  return pid;
}

beforeEach(() => {
  // CI's prebuilt runtime must not skip this fixture's modeled build commands.
  vi.stubEnv("OPENCLAW_E2E_SKIP_BUILD", undefined);
  vi.stubEnv("OPENCLAW_E2E_USE_PREBUILT_DIST", undefined);
});
afterEach(() => vi.unstubAllEnvs());

it("runs both build commands sequentially with their exact environments", async () => {
  const firstCommand = createDeferred<number>();
  const runCommand = vi
    .fn<SetupCommandRunner>()
    .mockReturnValueOnce(firstCommand.promise)
    .mockResolvedValueOnce(0);

  const setupPromise = runE2eGlobalSetup(runCommand);
  expect(runCommand).toHaveBeenCalledTimes(1);
  firstCommand.resolve(0);
  await setupPromise;
  const prepareEnv = {
    ...process.env,
    OPENCLAW_BUILD_PRIVATE_QA: "1",
    OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
  };
  expect(runCommand.mock.calls).toEqual([
    [["scripts/prepare-vitest-runtime.mjs"], prepareEnv],
    [aiBuild, process.env],
  ]);
});

it("propagates a nonzero command status", async () => {
  const runCommand = vi.fn<SetupCommandRunner>().mockResolvedValueOnce(0).mockResolvedValueOnce(23);
  await expect(runE2eGlobalSetup(runCommand)).rejects.toThrow(
    `E2E setup command failed with exit code 23: ${aiBuild.join(" ")}`,
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

posixIt(
  "forwards output and SIGTERM through the runner process group",
  async ({ signal, onTestFinished }) => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-setup-group-"));
    const fixturePath = path.join(fixtureDir, "scripts", "prepare-vitest-runtime.mjs");
    const pidPaths = ["child.pid", "descendant.pid"].map((name) => path.join(fixtureDir, name));
    let cleanup = async () => fs.rmSync(fixtureDir, { force: true, recursive: true });
    onTestFinished(() => cleanup());
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
    const argv = resolveRuntimeWorkerArgv(setupUrl).slice(0, -1);
    argv.push("--input-type=module", "--eval", runnerScript);
    const runner = spawn(process.execPath, argv, { detached: true, stdio: "pipe" });
    const closed = new Promise<ProcessExit>((resolve) => {
      runner.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    const groupState = () => inspectManagedProcessGroup(runner, { errorPolicy: "indeterminate" });
    cleanup = async () => {
      await runQaGatewayFixture(
        async () => forceKillVitestProcessGroup(runner),
        () => killPidIfAlive(runner.pid),
        ...pidPaths.map((file) => async () => {
          if (fs.existsSync(file)) {
            killPidIfAlive(readFixturePid(file));
          }
        }),
        async () => {
          // Runner closure and group death are separate; retain PID evidence until both settle.
          await runQaGatewayFixture(
            () => closed,
            async () => {
              try {
                while (runner.pid && groupState() !== "dead") {
                  await waitForProcessTick(10, undefined, { signal });
                }
              } catch (cause) {
                throw new Error(`runner group still alive; retained fixture: ${fixtureDir}`, {
                  cause,
                });
              }
            },
          );
          fs.rmSync(fixtureDir, { force: true, recursive: true });
        },
      );
    };
    const output = { stdout: "", stderr: "" };
    const outputReady = (["stdout", "stderr"] as const).map((name) => {
      const ready = createDeferred();
      runner[name].setEncoding("utf8").on("data", (chunk: string) => {
        output[name] += chunk;
        if (output[name].includes(`setup-${name}`)) {
          ready.resolve();
        }
      });
      return ready.promise;
    });
    await withinTest(once(runner, "spawn"), signal);
    runner.stdin.write("start\n");
    await withinTest(
      awaitGateBeforeSettlement(
        Promise.all(outputReady),
        closed,
        `timeout waiting for pid in ${pidPaths[0]}`,
      ),
      signal,
    );
    // Both PID writes precede setup-stdout in the fixture, which the runner forwards.
    const pids = pidPaths.map(readFixturePid);
    expect(output.stdout).toContain("setup-stdout");
    expect(output.stderr).toContain("setup-stderr");
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
    await Promise.all(pids.map((pid) => waitForDead(pid, signal)));
  },
);
