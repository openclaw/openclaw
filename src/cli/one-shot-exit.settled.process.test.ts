import type { ChildProcess } from "node:child_process";
import { it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

// The real ten-second production bound is intentional: this composes the actual
// Gateway cleanup producer and CLI consumer without a new test-only timeout seam.
it.skipIf(process.platform === "win32")(
  "bounds a real Gateway cleanup leak only after CLI finalization",
  async ({ expect, signal, onTestFinished }) => {
    const fixture = createFixtureLifetime();
    onTestFinished(() => fixture.cleanup());
    await fixture.run(async () => {
      const directory = fixture.createTempDir("openclaw-settled-exit-");
      const script = `
        import { once } from "node:events";
        import { createServer } from "node:net";
        import { setTimeout as delay } from "node:timers/promises";
        import { createGatewayRunCleanup } from ${JSON.stringify(new URL("./gateway-cli/run-loop-cleanup.ts", import.meta.url).href)};
        import { runCliWithExitFinalization } from ${JSON.stringify(new URL("./one-shot-exit.ts", import.meta.url).href)};
        const cleanup = createGatewayRunCleanup(true, {
          stopActiveManagedProviderLocalServices: async () => {},
        }, { warn() {}, error() {} }, () => false);
        const server = createServer().listen(0, "127.0.0.1");
        await once(server, "listening");
        process.on("SIGTERM", () => {});
        await runCliWithExitFinalization({
          run: async () => {
            await cleanup.drainProcessResources();
            process.exitCode = await cleanup.settleFinalResources({
              getExitCode: () => 0,
              retireSignals() {},
              drainSignals: async () => {},
              closeTerminalServer: async () => {},
              retireHost: () => undefined,
              closeSharedState: async () => {},
              releaseLock: async () => {},
              clearStartupWatchdog() {},
              requestWatchdogs: new Set(),
              cleanupSignals: () => cleanup.releaseProcessLifetime(),
              onSettled: outcome => process.stdout.write(outcome + "\\n"),
            });
          },
          finalize: async () => {
            await delay(400);
            process.stdout.write("finalized\\n");
          },
          onError: error => { throw error; },
        });
        // Baseline exits naturally after this fallback; the repair must use SIGTERM.
        setTimeout(() => server.close(), 12_000).unref();
      `;
      let child: ChildProcess | undefined;
      const result = await fixture.track(
        runNodeScript(
          ["--import", "tsx", "--input-type=module", "--eval", script],
          {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: directory,
            USERPROFILE: directory,
            OPENCLAW_STATE_DIR: directory,
            NODE_DISABLE_COMPILE_CACHE: "1",
            TSX_DISABLE_CACHE: "1",
          },
          20_000,
          {
            signal,
            onReady: (started) => {
              child = started;
            },
          },
        ),
      );
      const diagnostics = JSON.stringify(result);
      expect(result.error, diagnostics).toBeUndefined();
      expect(result.stdout, diagnostics).toBe("drained\nfinalized\n");
      expect(result.stderr, diagnostics).toContain("still alive after 10000ms; active resources:");
      expect(result.stderr, diagnostics).toContain("; terminating");
      expect(child?.signalCode, diagnostics).toBe("SIGTERM");
      expect(result.status, diagnostics).toBe(143);
    });
  },
);
