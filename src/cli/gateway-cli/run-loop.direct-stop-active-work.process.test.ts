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

const moduleUrl = (entry: Parameters<typeof resolveRuntimeWorkerUrl>[0]) =>
  resolveRuntimeWorkerUrl(entry).href;

const childScript = `
  import fs from "node:fs";
  import { createChannelIngressDrain } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.ingressDrain))};
  import { createChannelIngressQueue } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.ingressQueue))};
  import {
    attachActiveEmbeddedRun,
    detachActiveEmbeddedRun,
  } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.runs))};
  import { withSessionTurn } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.sessionControllerAdmission))};
  import { getActiveSessionRunCount } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.sessionControllerQueries))};
  import { runGatewayLoop } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.runLoop))};
  import { getActiveGatewayRootWorkCount } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.workAdmission))};

  const [tracePath, stateDir] = process.argv.slice(1);
  const trace = (line) => {
    fs.appendFileSync(tracePath, line + "\\n");
    process.stdout.write("process proof: " + line + "\\n");
  };
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
        trace(
          "adopted:roots=" +
            getActiveGatewayRootWorkCount() +
            ":embedded=" +
            getActiveSessionRunCount(),
        );
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

function readTrace(tracePath: string): string[] {
  return fs.readFileSync(tracePath, "utf8").split("\n").filter(Boolean);
}

const posixIt = process.platform === "win32" ? it.skip : it;

posixIt("joins forced child cleanup before deleting its fixture directory", async ({ signal }) => {
  const fixtureDir = fixtures.make("openclaw-direct-stop-failure-");
  const child = spawn(
    process.execPath,
    ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1_000)'],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const { closed } = fixtures.ownChild(child);
  let rootExistsAtClose = false;
  child.once("close", () => {
    rootExistsAtClose = fs.existsSync(fixtureDir);
  });
  await withinTest(
    awaitGateBeforeSettlement(
      once(child.stdout!, "data"),
      closed,
      "forced cleanup fixture did not start",
    ),
    signal,
  );

  await fixtures.cleanup();

  expect(await closed).toEqual([null, "SIGKILL"]);
  expect(rootExistsAtClose).toBe(true);
  expect(fs.existsSync(fixtureDir)).toBe(false);
});

posixIt(
  "reports and drains a rootless adopted channel run after OS SIGTERM",
  async ({ signal }) => {
    const fixtureDir = fixtures.make("openclaw-direct-stop-active-work-");
    const stateDir = path.join(fixtureDir, "state");
    const homeDir = path.join(fixtureDir, "home");
    const tracePath = path.join(fixtureDir, "trace.log");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childScript, tracePath, stateDir],
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

    await withinTest(
      awaitGateBeforeSettlement(
        ready.promise,
        tracked.closed,
        "gateway-ready trace was not produced",
      ),
      signal,
    ).catch((cause: unknown) => {
      throw new Error(formatCliProcessFailure({ reason: String(cause), ...tracked.output }), {
        cause,
      });
    });
    // The exit event can precede the final stdout data; close joins both streams.
    expect(child.kill("SIGTERM")).toBe(true);

    const exit = await withinTest(tracked.closed, signal);
    const trace = readTrace(tracePath);
    expect(exit, `${trace.join(" -> ")}\n${tracked.output.stderr}`).toEqual([0, null]);
    expect(trace).toContain("adopted:roots=0:embedded=1");
    expect(trace).not.toContain("embedded-aborted");
    expect(trace.indexOf("signal:SIGTERM")).toBeLessThan(trace.indexOf("embedded-completed"));
    expect(trace.indexOf("embedded-completed")).toBeLessThan(trace.indexOf("gateway-close"));
    expect(trace.indexOf("gateway-close")).toBeLessThan(trace.indexOf("process-exit:0"));
    const output = tracked.output.stdout;
    const drainSettled = output.indexOf("active-work drain settled; beginning server close");
    const embeddedCompleted = output.indexOf("process proof: embedded-completed");
    expect(output).toContain("embeddedRuns=1");
    expect(output.indexOf("embeddedRuns=1")).toBeLessThan(embeddedCompleted);
    expect(drainSettled).toBeGreaterThanOrEqual(0);
    expect(drainSettled).toBeLessThan(output.indexOf("process proof: gateway-close"));
    expect(output).toContain("restart trace: stop.signal.received ");
    expect(output).toContain("restart trace: stop.drain.begin ");
    expect(output).toContain("restart trace: stop.drain ");
  },
  60_000,
);
