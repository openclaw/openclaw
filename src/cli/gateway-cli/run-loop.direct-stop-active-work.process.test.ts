import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
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
  import { createChannelIngressDrain } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.ingressDrain))};
  import { createChannelIngressQueue } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.ingressQueue))};
  import { attachActiveEmbeddedRun, detachActiveEmbeddedRun } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.runs))};
  import { withSessionTurn } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.sessionControllerAdmission))};
  import { getActiveSessionRunCount } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.sessionControllerQueries))};
  import { runGatewayLoop } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.runLoop))};
  import { getActiveGatewayRootWorkCount } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.workAdmission))};

  const [stateDir] = process.argv.slice(1);
  const trace = (line) => process.stdout.write("process proof: " + line + "\\n");
  const queue = createChannelIngressQueue({ channelId: "process-proof", accountId: "direct-stop", stateDir });
  const embedded = Promise.withResolvers();
  const adopted = Promise.withResolvers();
  const sessionId = "direct-stop-active-work";
  const sessionKey = "agent:main:process-proof:direct-stop-active-work";
  const handle = {
    runId: "run-direct-stop-active-work",
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort: () => trace("embedded-aborted"),
  };
  const drain = createChannelIngressDrain({
    queue,
    // A keyed native run registers only under its controller turn admission.
    dispatchClaimedEvent: (_event, lifecycle) =>
      withSessionTurn({ sessionKey, sessionId }, async (operation) => {
        const registration = attachActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, undefined, operation);
        await lifecycle.onAdopted();
        trace("adopted:roots=" + getActiveGatewayRootWorkCount() + ":embedded=" + getActiveSessionRunCount());
        adopted.resolve();
        await embedded.promise;
        detachActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, undefined, registration);
        trace("embedded-completed");
      }).catch((error) => {
        // Fail fast: a dispatch failure would otherwise leave startup waiting for adoption.
        trace("dispatch-failed:" + error.message);
        process.exit(1);
      }),
  });

  await queue.enqueue("event-direct-stop", { text: "hello" }, { laneKey: sessionKey });
  process.prependOnceListener("SIGTERM", () => {
    trace("signal:SIGTERM");
    setTimeout(() => embedded.resolve(), 400);
  });

  const code = await runGatewayLoop({
    ownsProcessLifecycle: true,
    start: async () => {
      await drain.drainOnce();
      await adopted.promise;
      setImmediate(() => trace("gateway-ready"));
      return {
        getTailscaleIngressEndpoint: () => undefined,
        startupSettled: Promise.resolve(),
        close: async () => {
          trace("gateway-close");
          drain.dispose();
        },
      };
    },
    lockPort: 19473,
  });
  process.exitCode = code;
  process.once("beforeExit", () => trace("process-exit:" + code));
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

posixIt(
  "reports and drains a rootless adopted channel run after OS SIGTERM",
  async ({ signal }) => {
    const fixtureDir = fixtures.make("openclaw-direct-stop-active-work-");
    const stateDir = path.join(fixtureDir, "state");
    const homeDir = path.join(fixtureDir, "home");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childScript, stateDir],
      {
        env: {
          ...process.env,
          HOME: homeDir,
          NODE_ENV: undefined,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_OPTIONS: undefined,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_GATEWAY_RESTART_TRACE: "1",
          VITEST: undefined,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Register close before readiness: failed startup still owns both output streams.
    const tracked = fixtures.ownChild(child);
    const ready = createDeferred();
    child.stdout?.on("data", () => {
      if (tracked.output.stdout.includes("process proof: gateway-ready\n")) {
        ready.resolve();
      }
    });

    await waitForFixture(ready.promise, tracked, signal);
    // The exit event can precede the final stdout data; close joins both streams.
    expect(child.kill("SIGTERM")).toBe(true);

    const exit = await withinTest(tracked.closed, signal);
    const output = tracked.output.stdout;
    expect(exit, `${output}\n${tracked.output.stderr}`).toEqual([0, null]);
    expect(output).toContain("process proof: adopted:roots=0:embedded=1");
    expect(output).not.toContain("embedded-aborted");
    expect(output).toMatch(
      /process proof: signal:SIGTERM[\s\S]*process proof: embedded-completed[\s\S]*process proof: gateway-close[\s\S]*process proof: process-exit:0/,
    );
    expect(output).toMatch(/embeddedRuns=1[\s\S]*process proof: embedded-completed/);
    expect(output).toMatch(
      /active-work drain settled; beginning server close[\s\S]*process proof: gateway-close/,
    );
    for (const phase of ["stop.signal.received", "stop.drain.begin", "stop.drain"]) {
      expect(output).toContain(`restart trace: ${phase} `);
    }
  },
  60_000,
);
