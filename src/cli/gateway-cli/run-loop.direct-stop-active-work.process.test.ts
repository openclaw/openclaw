import { spawn } from "node:child_process";
import { once } from "node:events";
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

const childScript = (finalizerFails: boolean) => `
  import { writeSync } from "node:fs";
  import { runGatewayLoop } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.runLoop))};
  import { PluginRuntimeCloseRetainedError } from ${JSON.stringify(pathToFileURL(path.resolve("src/plugins/runtime-close-error.ts")).href)};

  const trace = (line) => writeSync(1, "process proof: " + line + "\\n");
  let starts = 0;
  const code = await runGatewayLoop({
    ownsProcessLifecycle: true,
    onProcessResourcesSettled: (outcome) => {
      trace("custody:" + outcome);
      if (${JSON.stringify(finalizerFails)}) {
        throw new Error("synthetic finalizer failure");
      }
    },
    start: async () => {
      trace("start:" + ++starts);
      // The fake service child misses its cleanup deadline and keeps Node alive.
      setInterval(() => {}, 1000);
      setImmediate(() => trace("gateway-ready"));
      return {
        getTailscaleIngressEndpoint: () => undefined,
        startupSettled: Promise.resolve(),
        close: async () => {
          trace("service-child-cleanup-deadline");
          throw new PluginRuntimeCloseRetainedError(new Error("service child cleanup deadline"));
        },
      };
    },
  });
  trace("loop-returned:" + code);
`;

const posixIt = process.platform === "win32" ? it.skip : it;

posixIt("joins forced child cleanup before deleting its fixture directory", async ({ signal }) => {
  const fixtureDir = fixtures.make("openclaw-direct-stop-failure-");
  const child = spawn(
    process.execPath,
    ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1_000)'],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const tracked = fixtures.ownChild(child);
  let rootExistsAtClose = false;
  child.once("close", () => {
    rootExistsAtClose = fs.existsSync(fixtureDir);
  });
  await waitForFixture(once(child.stdout!, "data"), tracked, signal);

  await fixtures.cleanup();

  expect(await tracked.closed).toEqual([null, "SIGKILL"]);
  expect(rootExistsAtClose).toBe(true);
  expect(fs.existsSync(fixtureDir)).toBe(false);
});

posixIt.for([
  { stopSignal: "SIGTERM", finalizerFails: false, code: 0 },
  { stopSignal: "SIGUSR2", finalizerFails: false, code: 0 },
  { stopSignal: "SIGTERM", finalizerFails: true, code: 1 },
] as const)(
  "exits $code with a retained child after $stopSignal (finalizer rejects: $finalizerFails)",
  { timeout: 60_000 },
  async ({ stopSignal, finalizerFails, code }, { signal }) => {
    const fixtureDir = fixtures.make("openclaw-retained-shutdown-");
    const stateDir = path.join(fixtureDir, "state");
    const homeDir = path.join(fixtureDir, "home");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childScript(finalizerFails)],
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
    expect(child.kill(stopSignal)).toBe(true);
    const exit = await withinTest(tracked.closed, signal);
    const diagnostics = `${tracked.output.stdout}\n${tracked.output.stderr}`;
    expect(exit, diagnostics).toEqual([code, null]);
    expect(tracked.output.stdout).toContain("process proof: service-child-cleanup-deadline");
    expect(tracked.output.stdout).toContain("process proof: custody:retained");
    expect(tracked.output.stdout).not.toContain("process proof: start:2");
    expect(tracked.output.stdout).not.toContain("process proof: loop-returned:");
    if (finalizerFails) {
      expect(diagnostics).toContain("synthetic finalizer failure");
    }
    if (stopSignal === "SIGUSR2") {
      expect(diagnostics).toContain("refusing in-process restart");
    }
  },
);
