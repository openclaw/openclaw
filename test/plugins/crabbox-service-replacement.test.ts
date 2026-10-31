import { fileURLToPath } from "node:url";
import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { expect, it, vi } from "vitest";
import crabboxPlugin from "../../extensions/crabbox/index.js";
import { PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS } from "../../src/plugins/services.js";
import { startPluginServices } from "../../src/plugins/services.test-support.js";
import { createDeferredCore } from "../../src/shared/deferred.js";
import { createServiceRegistry } from "./service-registry.test-support.js";

it("settles an active Crabbox heartbeat before strict replacement completes", async () => {
  const started = createDeferredCore();
  const finished = createDeferredCore<processRuntime.SpawnResult>();
  const cleanup = new AbortController();
  const commands: Array<Promise<processRuntime.SpawnResult>> = [];
  const runCommand = processRuntime.runCommandWithTimeout;
  const childScript = `
      process.on("SIGTERM", () => {});
      process.stdout.write("ready");
      setInterval(() => {}, 1000);
    `;
  let output = "";
  let childSettled = false;
  const runner = vi
    .spyOn(processRuntime, "runCommandWithTimeout")
    .mockImplementation(async (argv, options) => {
      if (argv[1] === "heartbeat") {
        const command = runCommand([process.execPath, "-e", childScript], {
          ...(typeof options === "number" ? { timeoutMs: options } : options),
          signal: AbortSignal.any([
            cleanup.signal,
            ...(typeof options === "object" && options.signal ? [options.signal] : []),
          ]),
          onOutputChunk: (chunk, stream) => {
            if (stream === "stdout") {
              output += chunk.toString();
              if (output === "ready") {
                started.resolve();
              }
            }
          },
        });
        commands.push(command);
        void command.then((result) => {
          childSettled = true;
          finished.resolve(result);
        }, finished.reject);
        return await command;
      }
      return {
        stdout:
          argv[1] === "--version"
            ? "999.0.0"
            : JSON.stringify({
                id: "cbx_replacement",
                providerMetadata: { instanceProfileAttached: false },
                ready: true,
                state: "running",
              }),
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });
  let provider!: WorkerProvider;
  const { api, registry } = createServiceRegistry("crabbox", {
    source: "test",
    rootDir: fileURLToPath(new URL("../../extensions/crabbox/", import.meta.url)),
    registerWorkerProvider: (registered) => {
      provider = registered;
    },
  });
  crabboxPlugin.register(api);
  const handle = await startPluginServices({ registry, config: {} });
  const lease = {
    leaseId: "cbx_replacement",
    profile: { binary: "/mock/crabbox", provider: "aws", idleTimeout: "12s", ttl: "24h" },
  };
  try {
    await provider.inspect(lease);
    await Promise.race([started.promise, finished.promise]);
    expect(childSettled, "heartbeat exited before readiness").toBe(false);
    await handle.stop({
      strict: true,
      deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
    });
    expect(childSettled).toBe(true);
    const result = await finished.promise;
    expect(result).toMatchObject({ pid: expect.any(Number), termination: "signal" });
    expect(processRuntime.isPidDefinitelyDead(result.pid!)).toBe(true);

    vi.useFakeTimers();
    await provider.inspect(lease);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runner.mock.calls.filter(([argv]) => argv[1] === "heartbeat")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    cleanup.abort();
    await Promise.allSettled([handle.stop(), ...commands]);
    runner.mockRestore();
  }
});
