import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { gatewayDirectStopEntrypoints } from "../cli-entrypoint.test-support.js";
import { formatCliProcessFailure } from "../cli-process-child.test-helpers.js";
import { createProcessFixtures } from "./run-loop-process.test-support.js";

const fixtures = createProcessFixtures("direct-stop fixture cleanup failed; retaining state");

async function waitForFixture(
  gate: Promise<unknown>,
  tracked: ReturnType<typeof fixtures.ownChild>,
  signal: AbortSignal,
) {
  await withinTest(
    awaitGateBeforeSettlement(gate, tracked.closed, "fixture not ready"),
    signal,
  ).catch((cause: unknown) => {
    throw new Error(formatCliProcessFailure({ reason: String(cause), ...tracked.output }), {
      cause,
    });
  });
}

const moduleUrl = (entry: Parameters<typeof resolveRuntimeWorkerUrl>[0]) =>
  resolveRuntimeWorkerUrl(entry).href;

const childScript = `
  import assert from "node:assert/strict";
  import { writeSync } from "node:fs";
  import { runGatewayLoop } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.runLoop))};
  import { writeGatewayRestartIntentSync } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.restartIntent))};
  import { PluginRuntimeCloseRetainedError } from ${JSON.stringify(pathToFileURL(path.resolve("src/plugins/runtime-close-error.ts")).href)};

  const trace = (line) => writeSync(1, "process proof: " + line + "\\n");
  let starts = 0;
  const code = await runGatewayLoop({
    ownsProcessLifecycle: true,
    onProcessResourcesSettled: (outcome) => {
      trace("custody:" + outcome);
    },
    start: async () => {
      trace("start:" + ++starts);
      const child = setInterval(() => {}, 1000);
      if (process.argv[1] === "SIGUSR2") {
        assert(writeGatewayRestartIntentSync({
          targetPid: process.pid,
          intent: { force: true },
        }));
      }
      setImmediate(() => trace("gateway-ready"));
      return {
        getTailscaleIngressEndpoint: () => undefined,
        startupSettled: Promise.resolve(),
        close: async () => {
          // The child releases its owned handle but cannot confirm final cleanup.
          clearInterval(child);
          trace("service-child-cleanup-deadline");
          throw new PluginRuntimeCloseRetainedError(new Error("service child cleanup deadline"));
        },
      };
    },
  });
  trace("loop-returned:" + code);
`;

const posixIt = process.platform === "win32" ? it.skip : it;

posixIt.for(["SIGTERM", "SIGUSR2"] as const)(
  "terminates with retained child cleanup after %s without reusing the runtime",
  { timeout: 60_000 },
  async (stopSignal, { signal }) => {
    const fixtureDir = fixtures.make("openclaw-retained-shutdown-");
    const stateDir = path.join(fixtureDir, "state");
    const homeDir = path.join(fixtureDir, "home");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childScript, stopSignal],
      {
        env: {
          ...process.env,
          HOME: homeDir,
          NODE_ENV: undefined,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_OPTIONS: undefined,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_NO_RESPAWN: "1",
          VITEST: undefined,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const tracked = fixtures.ownChild(child);
    const ready = createDeferred();
    child.stdout?.on("data", () => {
      if (tracked.output.stdout.includes("process proof: gateway-ready\n")) {
        ready.resolve();
      }
    });
    await waitForFixture(ready.promise, tracked, signal);
    const stoppedAt = Date.now();
    expect(child.kill(stopSignal)).toBe(true);
    const exit = await withinTest(tracked.closed, signal).catch((cause: unknown) => {
      throw new Error(formatCliProcessFailure({ reason: String(cause), ...tracked.output }), {
        cause,
      });
    });
    const diagnostics = `${tracked.output.stdout}\n${tracked.output.stderr}`;
    expect(exit[0] !== null || exit[1] !== null, diagnostics).toBe(true);
    expect(Date.now() - stoppedAt, diagnostics).toBeLessThan(10_000);
    expect(tracked.output.stdout).toContain("process proof: service-child-cleanup-deadline");
    expect(tracked.output.stdout).toContain("process proof: custody:retained");
    expect(tracked.output.stdout).not.toContain("process proof: start:2");
    if (stopSignal === "SIGUSR2") {
      expect(diagnostics).toContain("refusing in-process restart");
    }
  },
);
