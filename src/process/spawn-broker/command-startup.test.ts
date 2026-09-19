import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { runCommandWithTimeout, runExec } from "../exec.js";
import { runWithSpawnBroker } from "./context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("command startup cancellation", () => {
  it.each([false, true])(
    "keeps one runExec deadline across admission and execution (cooperative exit: %s)",
    async (cooperative) => {
      const host = createSpawnBrokerHost();
      await host.ready();
      const spawnExeca = host.spawnExeca.bind(host);
      let remote: ReturnType<SpawnBrokerHost["spawnExeca"]> | undefined;
      vi.spyOn(host, "spawnExeca").mockImplementation((...args) => {
        remote = spawnExeca(...args);
        return remote;
      });
      const source = `
        ${cooperative ? "process.on('SIGTERM',()=>{process.stdout.write('-stopped');process.exit(0)});" : ""}
        process.stdout.write('started');process.stderr.write('diagnostic');
        setTimeout(()=>process.stdout.write('-finished'),1400);
      `;
      process.kill(host.pid!, "SIGSTOP");
      try {
        const command = runWithSpawnBroker(host, () =>
          runExec(process.execPath, ["-e", source], {
            timeoutMs: 2000,
            logOutput: false,
          }),
        );
        const outcome = command.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await delay(900);
        process.kill(host.pid!, "SIGCONT");
        await withTestTimeout(
          remote!.child.ready(),
          1000,
          "command did not start within its remaining budget",
        );
        expect(await outcome).toMatchObject({
          error: {
            timedOut: true,
            message: "Command timed out",
            shortMessage: "Command timed out",
            stdout: cooperative ? "started-stopped" : "started",
            stderr: "diagnostic",
            ...(cooperative ? { exitCode: 0 } : { signal: "SIGTERM" }),
          },
        });
        await remote!.child.waitForClose();
        expect(isPidDefinitelyDead(remote!.child.pid!)).toBe(true);
      } finally {
        try {
          process.kill(host.pid!, "SIGCONT");
        } catch {}
        if (remote) {
          remote.child.kill("SIGKILL");
          await remote.result.catch(() => {});
        }
        await host.close();
        vi.restoreAllMocks();
      }
    },
  );

  it.each([
    { api: "exec", reason: "timeout" },
    { api: "exec", reason: "signal" },
    { api: "runner", reason: "timeout" },
    { api: "runner", reason: "signal" },
    { api: "runner", reason: "no-output-timeout" },
  ] as const)(
    "settles $api $reason while the broker cannot complete startup",
    async ({ api, reason }) => {
      const host = createSpawnBrokerHost();
      await host.ready();
      const spawnExeca = host.spawnExeca.bind(host);
      let remote: ReturnType<SpawnBrokerHost["spawnExeca"]> | undefined;
      vi.spyOn(host, "spawnExeca").mockImplementation((...args) => {
        remote = spawnExeca(...args);
        return remote;
      });
      const controller = new AbortController();
      const beforeInput = vi.fn();
      const args = ["-e", "setInterval(()=>{},1000)"];
      process.kill(host.pid!, "SIGSTOP");
      try {
        const command = runWithSpawnBroker(host, () =>
          api === "exec"
            ? runExec(process.execPath, args, {
                signal: controller.signal,
                timeoutMs: reason === "timeout" ? 50 : undefined,
                logOutput: false,
              })
            : runCommandWithTimeout([process.execPath, ...args], {
                signal: controller.signal,
                timeoutMs: reason === "timeout" ? 50 : undefined,
                noOutputTimeoutMs: reason === "no-output-timeout" ? 50 : undefined,
                killProcessTree: true,
                input: "not admitted",
                beforeInput,
              }),
        );
        if (reason === "signal") {
          controller.abort();
        }
        const outcome = await Promise.race([
          command.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          ),
          delay(500).then(() => ({ pending: true })),
        ]);
        expect(outcome).not.toHaveProperty("pending");
        if (api === "exec") {
          expect(outcome).toMatchObject({
            error: reason === "timeout" ? { timedOut: true } : { isCanceled: true },
          });
        } else {
          expect(outcome).toMatchObject({ value: { termination: reason, cleanup: "uncertain" } });
        }
        expect(beforeInput).not.toHaveBeenCalled();
        expect(remote).toBeDefined();
        process.kill(host.pid!, "SIGCONT");
        await withTestTimeout(remote!.result, 5_000, "late command cancellation did not settle");
        await remote!.child.waitForClose();
        expect(isPidDefinitelyDead(remote!.child.pid!)).toBe(true);
        expect(beforeInput).not.toHaveBeenCalled();
      } finally {
        try {
          process.kill(host.pid!, "SIGCONT");
        } catch {}
        if (remote) {
          await withTestTimeout(
            remote.child.ready(),
            5_000,
            "late command did not reach readiness",
          ).catch(() => {});
          remote.child.kill("SIGKILL");
          await remote.result.catch(() => {});
        }
        await host.close();
        vi.restoreAllMocks();
      }
    },
  );
});
