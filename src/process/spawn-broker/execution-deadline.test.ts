import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { runCommandWithTimeout, runExec } from "../exec.js";
import { runWithSpawnBroker } from "./context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

describe.skipIf(!supportsSpawnBrokerCommandTransport())(
  "independent broker execution deadline",
  () => {
    let host: SpawnBrokerHost;
    beforeAll(async () => {
      host = createSpawnBrokerHost();
      await host.ready();
    });
    afterAll(async () => {
      await host.close();
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it.each(["exec", "runner"] as const)(
      "stops %s execution without processing the Gateway watchdog",
      async (api) => {
        const spawn = host.spawnExeca.bind(host);
        let remote: ReturnType<SpawnBrokerHost["spawnExeca"]> | undefined;
        const observeSpawn = vi.spyOn(host, "spawnExeca").mockImplementation((argv, options) => {
          remote = spawn(argv, options);
          return remote;
        });
        const controller = new AbortController();
        // Keep native IPC live while withholding every Gateway timeout callback.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const args = ["-e", "process.stdout.write('running');setInterval(()=>{},1000)"];
        const options = { timeoutMs: 200, signal: controller.signal };
        const command = runWithSpawnBroker(host, () =>
          api === "exec"
            ? runExec(process.execPath, args, { ...options, logOutput: false })
            : runCommandWithTimeout([process.execPath, ...args], options),
        );
        const outcome = command.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        try {
          expect(observeSpawn.mock.calls[0]?.[1]).toMatchObject({ executionDeadlineMs: 1_200 });
          expect(observeSpawn.mock.calls[0]?.[1].timeout).toBeUndefined();
          expect(remote).toBeDefined();
          const hostKill = vi.spyOn(remote!.child, "kill");
          expect(await outcome).toMatchObject(
            api === "exec"
              ? { error: { timedOut: true, message: "Command timed out", stdout: "running" } }
              : { value: { code: 124, termination: "timeout", killed: true, stdout: "running" } },
          );
          expect(hostKill).not.toHaveBeenCalled();
          expect(isPidDefinitelyDead(remote!.child.pid!)).toBe(true);
        } finally {
          vi.useRealTimers();
          controller.abort();
          remote?.child.kill("SIGKILL");
          await outcome;
        }
      },
    );
  },
);
