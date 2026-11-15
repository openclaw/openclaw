import { spawn } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { DOCKER_SANDBOX_ENGINE, execContainerRaw } from "../../agents/sandbox/container-engine.js";
import { writeFakeContainerExecutable } from "../../agents/sandbox/container-engine.scope.test-support.js";
import { executeGitCommandBuffered } from "../../infra/git-exec.js";
import { runInDetachedAsyncContext } from "../../shared/detached-async-context.js";
import { runCommandBuffersWithTimeout, runCommandWithTimeout } from "../exec-runner.js";
import { withChildProcessOperation } from "../spawn-diagnostics.js";
import { spawnAndWait } from "../spawn-utils.js";
import { runWithSpawnBroker, startGatewaySpawnBroker } from "./context.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  const tracked = { ...actual };
  vi.spyOn(tracked, "spawn");
  return mockNodeBuiltinModule(() => Promise.resolve(actual), { spawn: tracked.spawn });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(!supportsSpawnBrokerCommandTransport())(
  "routes detached Gateway git, commands, and guarded exec through the running broker",
  async () => {
    const directory = tempDirs.make("openclaw-gateway-spawn-");
    writeFakeContainerExecutable(
      directory,
      "docker",
      "process.stdout.write(String(process.ppid));",
    );
    const broker = await startGatewaySpawnBroker({ onReady() {}, onStartupFailure: vi.fn() });
    expect(broker).toBeDefined();
    try {
      vi.mocked(spawn).mockClear();
      await runInDetachedAsyncContext(async () => {
        const git = await executeGitCommandBuffered(process.cwd(), ["--version"]);
        expect(git.stdout.toString()).toMatch(/^git version /);
        const argv = [process.execPath, "-e", "process.stdout.write(String(process.ppid))"];
        for (const run of [runCommandWithTimeout, runCommandBuffersWithTimeout]) {
          const result = await run(argv, 5_000);
          expect(result.code).toBe(0);
          expect(Number(result.stdout.toString())).toBe(broker!.pid);
        }
        const container = await execContainerRaw(
          { ...DOCKER_SANDBOX_ENGINE, baseEnv: { ...process.env, PATH: directory } },
          [],
        );
        expect(Number(container.stdout.toString())).toBe(broker!.pid);
        const child = await withChildProcessOperation("agent.exec", () =>
          spawnAndWait({
            argv,
            options: { stdio: ["ignore", "pipe", "pipe"] },
            initiateSpawn: (launch) => launch(),
          }),
        );
        const closed = once(child, "close");
        const output = text(child.stdout!);
        expect(await closed).toEqual([0, null]);
        expect(Number(await output)).toBe(broker!.pid);
      });
      expect(spawn).not.toHaveBeenCalled();
      const native = await runWithSpawnBroker(undefined, () =>
        runCommandWithTimeout([process.execPath, "-e", "console.log(process.ppid)"], 5_000),
      );
      expect(Number(native.stdout)).toBe(process.pid);
    } finally {
      await broker?.close();
      vi.restoreAllMocks();
    }
    const stopped = await runCommandWithTimeout(
      [process.execPath, "-e", "console.log(process.ppid)"],
      5_000,
    );
    expect(Number(stopped.stdout)).toBe(process.pid);
  },
);
