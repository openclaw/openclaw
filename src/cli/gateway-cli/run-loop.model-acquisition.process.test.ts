import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS } from "../../daemon/launchd-plist.js";
import { GATEWAY_SUPERVISOR_EXIT_MARGIN_MS } from "../../infra/gateway-shutdown-budget.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { gatewayDirectStopEntrypoints } from "../cli-entrypoint.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixtureUrl = resolveRuntimeWorkerUrl(gatewayDirectStopEntrypoints.modelAcquisitionFixture);
const stopTimeoutMs = LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS * 1_000;
const shutdownTimeoutMs = stopTimeoutMs - GATEWAY_SUPERVISOR_EXIT_MARGIN_MS;

it
  .skipIf(process.platform !== "darwin" && process.platform !== "linux")
  .each(["cooperative", "pending"])(
  "bounds a degraded fleet's %s acquisition through OS SIGTERM and the real shutdown owner",
  async (mode) => {
    const root = tempDirs.make("openclaw-model-shutdown-");
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    await fs.mkdir(home);
    await fs.mkdir(bin);
    // Only the native service query is synthetic. Budget selection, timers,
    // cancellation, Gateway close, and process exit all run unchanged.
    await fs.writeFile(
      path.join(bin, "systemctl"),
      `#!/bin/sh\nprintf 'LoadState=loaded\\nTimeoutStopUSec=${LAUNCH_AGENT_EXIT_TIMEOUT_SECONDS}s\\n'\n`,
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
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    try {
      await vi.waitFor(() => expect(output).toContain("process proof: gateway-ready-degraded"), {
        timeout: 45_000,
        interval: 25,
      });
      expect(output).toContain(`shutdown=${shutdownTimeoutMs}ms`);
      const started = performance.now();
      expect(child.kill("SIGTERM")).toBe(true);
      const exit = await withTestTimeout(
        closed,
        stopTimeoutMs,
        "fleet exceeded native stop budget",
      );
      const elapsed = performance.now() - started;
      expect(exit, output).toEqual([0, null]);
      expect(elapsed, output).toBeLessThan(stopTimeoutMs);
      expect(output).toContain("process proof: acquisition-cancelled");
      // The fixture's launchd label is synthetic, so the per-stop re-inspection cannot
      // find a job to read and the startup budget is retained instead. Both
      // attributions prove the same thing this case is guarding: the shutdown budget
      // came from the 20 second native stop timeout and not from the platform-neutral
      // policy, which would report a 330000ms source and a far longer deadline.
      expect(output).toMatch(
        new RegExp(
          `shutdown budget at shutdown:.*source=(?:.*=${stopTimeoutMs}ms|startup shutdown budget=${shutdownTimeoutMs}ms)`,
        ),
      );
      if (process.platform === "darwin") {
        // The label resolves to no real job, so this cannot assert a successful read.
        // What it does assert is that the darwin probe ran inside a real spawned
        // Gateway on a real stop: only the launchd reader emits this, and reverting the
        // darwin dispatch removes it.
        expect(output).toContain("Unable to inspect the launchd job");
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
      expect(output.indexOf("acquisition-cancelled")).toBeLessThan(
        output.indexOf("process-exit:0"),
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await withTestTimeout(closed, 5_000, "model shutdown fixture did not close");
    }
  },
  75_000,
);
