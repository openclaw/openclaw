import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { GATEWAY_SHUTDOWN_TIMEOUT_MS } from "../../infra/gateway-shutdown-budget.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { gatewayDirectStopEntrypoints } from "../cli-entrypoint.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixtureUrl = resolveRuntimeWorkerUrl(gatewayDirectStopEntrypoints.modelAcquisitionFixture);
// This synthetic native deadline keeps the real-process proof independent of
// the generated service policy, whose full drain takes several minutes.
const stopTimeoutSeconds = 10;
const stopTimeoutMs = stopTimeoutSeconds * 1_000;
// Short native deadlines reserve a quarter for supervisor exit.
const shutdownTimeoutMs = 7_500;

it
  .skipIf(process.platform !== "darwin" && process.platform !== "linux")
  .for(["cooperative", "pending"])(
  "bounds a degraded fleet's %s acquisition through OS SIGTERM and the real shutdown owner",
  { timeout: 75_000 },
  async (mode, { signal }) => {
    const root = tempDirs.make("openclaw-model-shutdown-");
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    await fs.mkdir(home);
    await fs.mkdir(bin);
    // Only the native service query is synthetic. Budget selection, timers,
    // cancellation, Gateway close, and process exit all run unchanged.
    await fs.writeFile(
      path.join(bin, "systemctl"),
      `#!/bin/sh\nprintf 'LoadState=loaded\\nTimeoutStopUSec=${stopTimeoutSeconds}s\\n'\n`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      path.join(bin, "launchctl"),
      `#!/bin/sh\nprintf '\\tstate = SIGTERMed\\n\\texit timeout = ${stopTimeoutSeconds}\\n\\tpid = %s\\n' "$(cat "$0.pid")"\n`,
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, [...resolveRuntimeWorkerArgv(fixtureUrl), root, mode], {
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: home,
        TMPDIR: root,
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.model-shutdown.test",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-model-shutdown-test.service",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    void closed.catch(() => {});
    let output = "";
    const ready = createDeferred();
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("process proof: gateway-ready-degraded")) {
        ready.resolve();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    try {
      // Native queries may run through the spawn broker, so their parent PID is
      // not necessarily the Gateway PID that the loaded job must identify.
      await fs.writeFile(path.join(bin, "launchctl.pid"), String(child.pid));
      await withinTest(
        awaitGateBeforeSettlement(
          ready.promise,
          closed,
          "process proof: gateway-ready-degraded was not produced",
        ),
        signal,
      );
      expect(output).toContain(
        `shutdown=${process.platform === "darwin" ? GATEWAY_SHUTDOWN_TIMEOUT_MS : shutdownTimeoutMs}ms`,
      );
      const started = performance.now();
      expect(child.kill("SIGTERM")).toBe(true);
      const exit = await withinTest(closed, signal);
      const elapsed = performance.now() - started;
      expect(exit, output).toEqual(mode === "cooperative" ? [0, null] : [null, "SIGKILL"]);
      expect(elapsed, output).toBeLessThan(stopTimeoutMs);
      expect(output).toContain("process proof: acquisition-cancelled");
      // The synthetic manager's loaded deadline must govern the actual stop,
      // including on macOS where native inspection happens only after SIGTERM.
      expect(output).toMatch(
        new RegExp(`shutdown budget at shutdown:.*source=.*=${stopTimeoutMs}ms`),
      );
      if (process.platform === "darwin") {
        expect(output).toContain(
          `source=launchd system/ai.openclaw.model-shutdown.test exit timeout=${stopTimeoutMs}ms`,
        );
      }
      if (mode === "cooperative") {
        expect(output).toContain("process proof: acquisition-joined");
        expect(output).not.toContain("shutdown deadline reached");
        expect(elapsed, output).toBeLessThan(shutdownTimeoutMs);
      } else {
        expect(output).not.toContain("process proof: acquisition-joined");
        expect(output).toContain("shutdown deadline reached");
        expect(elapsed, output).toBeGreaterThanOrEqual(shutdownTimeoutMs);
      }
      if (mode === "cooperative") {
        expect(output.indexOf("acquisition-cancelled")).toBeLessThan(
          output.indexOf("process-exit:0"),
        );
      } else {
        expect(output).not.toContain("process-exit:");
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }
  },
);
