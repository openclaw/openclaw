// Process-boundary proof for direct-stop draining after durable channel-turn adoption.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { gatewayDirectStopEntrypoints } from "../cli-entrypoint.test-support.js";

const TEST_TIMEOUT_MS = 60_000;
const RELEASE_DELAY_MS = 400;

const tempDirs = createTempDirTracker();
const children = new Map<ChildProcess, Promise<unknown[]>>();

function ownChild(child: ChildProcess): Promise<unknown[]> {
  const closed = once(child, "close");
  children.set(child, closed);
  void closed.catch(() => {});
  return closed;
}

async function cleanupFixtures() {
  for (const child of children.keys()) {
    child.kill("SIGKILL");
  }
  const results = await Promise.allSettled(children.values());
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) {
    throw new AggregateError(errors, "direct-stop fixture cleanup failed; retaining state");
  }
  children.clear();
  tempDirs.cleanup();
}

afterEach(cleanupFixtures);

const moduleUrl = (entry: Parameters<typeof resolveRuntimeWorkerUrl>[0]) =>
  resolveRuntimeWorkerUrl(entry).href;

const childScript = `
  import fs from "node:fs";
  import path from "node:path";
  import { createChannelIngressDrain } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.ingressDrain))};
  import { createChannelIngressQueue } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.ingressQueue))};
  import {
    clearActiveEmbeddedRun,
    setActiveEmbeddedRun,
  } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.runs))};
  import { getActiveEmbeddedRunCount } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.activeRunProjections))};
  import { runGatewayLoop } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.runLoop))};
  import { getActiveGatewayRootWorkCount } from ${JSON.stringify(moduleUrl(gatewayDirectStopEntrypoints.workAdmission))};

  const tracePath = process.argv[1];
  const stateDir = process.argv[2];
  const trace = (line) => {
    fs.appendFileSync(tracePath, line + "\\n");
    process.stdout.write("process proof: " + line + "\\n");
  };
  const queue = createChannelIngressQueue({
    channelId: "process-proof",
    accountId: "direct-stop",
    stateDir,
  });
  let releaseEmbedded;
  const embeddedMaySettle = new Promise((resolve) => {
    releaseEmbedded = resolve;
  });
  let resolveAdopted;
  const adopted = new Promise((resolve) => {
    resolveAdopted = resolve;
  });
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
    dispatchClaimedEvent: async (_event, lifecycle) => {
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      await lifecycle.onAdopted();
      trace(
        "adopted:roots=" +
          getActiveGatewayRootWorkCount() +
          ":embedded=" +
          getActiveEmbeddedRunCount(),
      );
      resolveAdopted();
      await embeddedMaySettle;
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      trace("embedded-completed");
    },
  });

  await queue.enqueue("event-direct-stop", { text: "hello" }, { laneKey: sessionKey });
  process.prependOnceListener("SIGTERM", () => {
    trace("signal:SIGTERM");
    setTimeout(() => releaseEmbedded(), ${RELEASE_DELAY_MS});
  });

  const code = await runGatewayLoop({
    ownsProcessLifecycle: true,
    start: async () => {
      await drain.drainOnce();
      await adopted;
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
  try {
    return fs.readFileSync(tracePath, "utf8").split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

describe("runGatewayLoop direct-stop active work", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt(
    "joins forced child cleanup before deleting its fixture directory",
    async ({ signal }) => {
      const fixtureDir = tempDirs.make("openclaw-direct-stop-failure-");
      const child = spawn(
        process.execPath,
        ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1_000)'],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const closed = ownChild(child);
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

      await cleanupFixtures();

      expect(await closed).toEqual([null, "SIGKILL"]);
      expect(rootExistsAtClose).toBe(true);
      expect(fs.existsSync(fixtureDir)).toBe(false);
    },
  );

  posixIt(
    "reports and drains a rootless adopted channel run after OS SIGTERM",
    async ({ signal }) => {
      const fixtureDir = tempDirs.make("openclaw-direct-stop-active-work-");
      const stateDir = path.join(fixtureDir, "state");
      const homeDir = path.join(fixtureDir, "home");
      const tracePath = path.join(fixtureDir, "trace.log");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(homeDir, { recursive: true });
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", childScript, tracePath, stateDir],
        {
          cwd: path.resolve("."),
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
      const exited = ownChild(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const ready = createDeferred();
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        if (Buffer.concat(stdout).toString("utf8").includes("process proof: gateway-ready\n")) {
          ready.resolve();
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

      await withinTest(
        awaitGateBeforeSettlement(ready.promise, exited, "gateway-ready trace was not produced"),
        signal,
      );
      // The exit event can precede the final stdout data; close joins both streams.
      expect(child.kill("SIGTERM")).toBe(true);

      const exit = await withinTest(exited, signal);
      expect(
        exit,
        `${readTrace(tracePath).join(" -> ")}\n${Buffer.concat(stderr).toString("utf8")}`,
      ).toEqual([0, null]);
      children.delete(child);
      const trace = readTrace(tracePath);
      expect(trace).toContain("adopted:roots=0:embedded=1");
      expect(trace).not.toContain("embedded-aborted");
      expect(trace.indexOf("signal:SIGTERM")).toBeLessThan(trace.indexOf("embedded-completed"));
      expect(trace.indexOf("embedded-completed")).toBeLessThan(trace.indexOf("gateway-close"));
      expect(trace.indexOf("gateway-close")).toBeLessThan(trace.indexOf("process-exit:0"));
      const output = Buffer.concat(stdout).toString("utf8");
      expect(output).toContain("embeddedRuns=1");
      expect(output.indexOf("embeddedRuns=1")).toBeLessThan(
        output.indexOf("process proof: embedded-completed"),
      );
      expect(output).toContain("active-work drain settled; beginning server close");
      expect(output.indexOf("active-work drain settled; beginning server close")).toBeLessThan(
        output.indexOf("process proof: gateway-close"),
      );
      expect(output).toContain("restart trace: stop.signal.received ");
      expect(output).toContain("restart trace: stop.drain.begin ");
      expect(output).toContain("restart trace: stop.drain ");
    },
    TEST_TIMEOUT_MS,
  );
});
