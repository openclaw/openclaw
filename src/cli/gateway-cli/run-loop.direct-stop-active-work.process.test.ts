import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { gatewayDirectStopEntrypoints } from "../cli-entrypoint.test-support.js";
import { formatCliProcessFailure } from "../cli-process-child.test-helpers.js";
import { finalizationFixtureClockUrl } from "../update-finalization-clock.test-support.js";
import { createProcessFixtures } from "./run-loop-process.test-support.js";

const fixtures = createProcessFixtures("direct-stop fixture cleanup failed; retaining state");

function createFixtureEnv(prefix: string, nodeFixture: boolean) {
  const fixtureDir = fixtures.make(prefix);
  const stateDir = path.join(fixtureDir, "state");
  const homeDir = path.join(fixtureDir, "home");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  return {
    ...process.env,
    HOME: homeDir,
    NODE_ENV: undefined,
    NODE_DISABLE_COMPILE_CACHE: "1",
    NODE_OPTIONS: undefined,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_NO_RESPAWN: "1",
    VITEST: undefined,
    ...(nodeFixture
      ? {
          ESBUILD_BINARY_PATH: createRequire(import.meta.resolve("esbuild")).resolve(
            `@esbuild/${process.platform}-${process.arch}/bin/esbuild`,
          ),
        }
      : {}),
  };
}

async function waitForFixture(
  text: string | RegExp,
  tracked: ReturnType<typeof fixtures.ownChild>,
  signal: AbortSignal,
) {
  const ready = createDeferred();
  const observe = () => {
    const output = `${tracked.output.stdout}\n${tracked.output.stderr}`;
    if (typeof text === "string" ? output.includes(text) : text.test(output)) {
      tracked.child.stdout?.off("data", observe);
      tracked.child.stderr?.off("data", observe);
      ready.resolve();
    }
  };
  tracked.child.stdout?.on("data", observe);
  tracked.child.stderr?.on("data", observe);
  observe();
  await withinTest(
    awaitGateBeforeSettlement(ready.promise, tracked.closed, "fixture not ready"),
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
  import { beginGatewayBootLifecycle, completeGatewayBootLifecycle } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.bootLifecycle))};
  import { PluginRuntimeCloseRetainedError } from ${JSON.stringify(pathToFileURL(path.resolve("src/plugins/runtime-close-error.ts")).href)};

  const trace = (line) => writeSync(1, "process proof: " + line + "\\n");
  let starts = 0;
  let bootId;
  const code = await runGatewayLoop({
    ownsProcessLifecycle: true,
    // Match CLI startup: the child owns boot publication before reporting ready.
    beginBoot: async (startedAtMs, previousOwner) => {
      const boot = await beginGatewayBootLifecycle(process.env, startedAtMs, previousOwner);
      assert(boot.id, "fixture boot publication failed");
      bootId = boot.id;
    },
    completeBoot: (completion) => {
      const completedBootId = bootId;
      bootId = undefined;
      return completeGatewayBootLifecycle(completedBootId, completion);
    },
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

posixIt.for(["SIGTERM", "SIGUSR2", "historical-SIGTERM"] as const)(
  "settles child cleanup custody after %s without reusing the runtime",
  { timeout: 60_000 },
  async (stopSignal, { signal }) => {
    const historical = stopSignal === "historical-SIGTERM";
    const env = createFixtureEnv("openclaw-retained-shutdown-", historical);
    if (historical) {
      // This case verifies that shutdown reaps the Linux spawn broker.
      fs.writeFileSync(
        env.OPENCLAW_CONFIG_PATH,
        JSON.stringify({ gateway: { resources: { profile: "standard" } } }),
      );
    }
    const child = spawn(
      historical ? resolveTestNodeExecPath() : process.execPath,
      historical
        ? [
            "--import",
            "tsx",
            new URL(moduleUrl(gatewayDirectStopEntrypoints.brokerCleanupFixture)).pathname,
          ]
        : ["--import", "tsx", "--input-type=module", "--eval", childScript, stopSignal],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const tracked = fixtures.ownChild(child);
    await waitForFixture("process proof: gateway-ready\n", tracked, signal);
    const stoppedAt = Date.now();
    const sent = child.kill(historical ? "SIGTERM" : stopSignal);
    expect(sent).toBe(true);
    const exit = await withinTest(tracked.closed, signal).catch((cause: unknown) => {
      throw new Error(formatCliProcessFailure({ reason: String(cause), ...tracked.output }), {
        cause,
      });
    });
    const diagnostics = `${tracked.output.stdout}\n${tracked.output.stderr}`;
    expect(exit[0] !== null || exit[1] !== null, diagnostics).toBe(true);
    if (stopSignal !== "SIGUSR2") {
      expect(exit, diagnostics).toEqual([0, null]);
    }
    expect(Date.now() - stoppedAt, diagnostics).toBeLessThan(10_000);
    expect(tracked.output.stdout).toContain("process proof: service-child-cleanup-deadline");
    expect(tracked.output.stdout.match(/process proof: custody:\w+/g), diagnostics).toEqual([
      `process proof: custody:${historical ? "drained" : "retained"}`,
    ]);
    expect(tracked.output.stdout).not.toContain("process proof: start:2");
    if (historical) {
      expect(diagnostics).not.toMatch(
        /hard-exit watchdog deadline|gateway\.(?:restart|stop)_close_failed|; resources remain/,
      );
      const broker = /spawn broker ready pid=(\d+)/.exec(diagnostics);
      expect(broker, diagnostics).not.toBeNull();
      expect(() => process.kill(Number(broker![1]), 0)).toThrow();
      const warnings = diagnostics
        .split("\n")
        .filter((line) => line.includes("Earlier cleanup failed:"));
      expect(warnings, diagnostics).toHaveLength(1);
      expect(warnings[0]).toMatch(/service child cleanup.*hard deadline; pending:/);
    }
    if (stopSignal === "SIGUSR2") {
      expect(diagnostics).toContain("refusing in-process restart");
    }
  },
);

posixIt(
  "exits through the stop watchdog with a borrowed native read and admits a successor",
  { timeout: 60_000 },
  async ({ signal, onTestFailed }) => {
    const env = createFixtureEnv("openclaw-borrowed-stop-", true);
    const sourceUrl = (relative: string) => new URL(relative, import.meta.url).href;
    const script = `
      import assert from "node:assert/strict";
      import { AsyncResource } from "node:async_hooks";
      import { writeSync } from "node:fs";
      import { runGatewayLoop } from ${JSON.stringify(sourceUrl("./run-loop.ts"))};
      import { openOpenClawStateDatabase } from ${JSON.stringify(sourceUrl("../../state/openclaw-state-db.ts"))};
      import { borrowOpenClawStateDatabaseForAsyncRead } from ${JSON.stringify(sourceUrl("../../state/openclaw-state-db-cache.ts"))};
      import { startFinalizationFixtureClock, advanceFinalizationFixtureClock } from ${JSON.stringify(finalizationFixtureClockUrl)};

      const trace = (line) => writeSync(1, "process proof: " + line + "\\n");
      const successor = process.argv[1] === "successor";
      // This startup read owns its reference, independently of server maintenance.
      const readOwner = new AsyncResource("late-startup-native-read");
      let read;
      process.on("message", (message) => {
        if (message === "inspect") {
          read.assertCurrent();
          assert.equal(read.database.db.prepare("SELECT 17 AS value").get().value, 17);
          trace("borrow-retained");
        } else if (message === "expire") {
          // Advance the existing stop timer and its hard-watchdog fallback, not wall time.
          advanceFinalizationFixtureClock(1_000_000);
          assert.fail("the process-owned hard watchdog did not terminate the Gateway");
        }
      });
      const code = await runGatewayLoop({
        ownsProcessLifecycle: true,
        start: async () => {
          if (!successor) {
            const database = openOpenClawStateDatabase();
            read = readOwner.runInAsyncScope(() => borrowOpenClawStateDatabaseForAsyncRead(database.path));
            assert(read);
            startFinalizationFixtureClock();
          }
          setImmediate(() => {
            trace(successor ? "successor-started" : "gateway-ready");
            if (successor) process.kill(process.pid, "SIGTERM");
          });
          return {
            getTailscaleIngressEndpoint: () => undefined,
            startupSettled: Promise.resolve(),
            close: async () => trace("server-closed"),
          };
        },
      });
      trace("loop-returned:" + code);
      process.disconnect();
      process.exitCode = code;
    `;
    const start = (mode: string) => {
      // The existing deadline clock uses node:test; Bun parents use the pinned Node fixture.
      const child = spawn(
        resolveTestNodeExecPath(),
        ["--import", "tsx", "--input-type=module", "--eval", script, mode],
        { env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      return fixtures.ownChild(child);
    };

    const predecessor = start("predecessor");
    onTestFailed(() => {
      console.error(
        formatCliProcessFailure({ reason: "borrowed-stop fixture failed", ...predecessor.output }),
      );
    });
    await waitForFixture("process proof: gateway-ready\n", predecessor, signal);
    expect(predecessor.child.kill("SIGTERM")).toBe(true);
    await waitForFixture(
      /Waiting for 1 active native borrower\(s\)|OpenClaw state database still has active native borrowers|Gateway state custody release did not settle/,
      predecessor,
      signal,
    );
    expect(predecessor.output.stderr + predecessor.output.stdout).toContain(
      "Waiting for 1 active native borrower(s) before retiring OpenClaw state database:",
    );
    expect(predecessor.output.stderr + predecessor.output.stdout).toContain(
      path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"),
    );
    predecessor.child.send("inspect");
    await waitForFixture("process proof: borrow-retained\n", predecessor, signal);
    predecessor.child.send("expire");
    expect(await withinTest(predecessor.closed, signal)).toEqual([null, "SIGKILL"]);
    expect(predecessor.output.stderr).toContain("hard-exit watchdog deadline reached");
    expect(predecessor.output.stderr).toContain("forcing SIGKILL");
    expect(predecessor.output.stdout).not.toContain("process proof: loop-returned:");

    const successor = start("successor");
    await waitForFixture("process proof: successor-started\n", successor, signal);
    expect(await withinTest(successor.closed, signal)).toEqual([0, null]);
    expect(successor.output.stdout).toContain("process proof: server-closed\n");
    expect(successor.output.stdout).toContain("process proof: loop-returned:0\n");
  },
);
