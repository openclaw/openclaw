import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { gatewayDirectStopEntrypoints } from "../cli-entrypoint.test-support.js";

const tempDirs = createTempDirTracker();
const children = new Map<ChildProcess, Promise<unknown[]>>();
const runLoopUrl = resolveRuntimeWorkerUrl(gatewayDirectStopEntrypoints.runLoop).href;
const restartUrl = resolveRuntimeWorkerUrl(gatewayDirectStopEntrypoints.restartPolicy).href;
const fileLogTransportUrl = resolveRuntimeWorkerUrl(
  gatewayDirectStopEntrypoints.fileLogTransport,
).href;

const childScript = `
  import fs from "node:fs";
  import http from "node:http";
  import { runGatewayLoop } from ${JSON.stringify(runLoopUrl)};
  import { setGatewayRestartPolicy } from ${JSON.stringify(restartUrl)};
  import { fileLogTransport } from ${JSON.stringify(fileLogTransportUrl)};
  const faultPath = process.argv[1];
  const closeFailure = process.argv[2];
  setGatewayRestartPolicy({ allowExternal: true });
  let starts = 0;
  try {
    await runGatewayLoop({
      ownsProcessLifecycle: true,
      onRestartStartupFailure: async () => {
        process.stdout.write("waiting:" + starts + "\\n");
      },
      start: async () => {
        const attempt = ++starts;
        process.stdout.write("start:" + attempt + "\\n");
        if (fs.existsSync(faultPath)) throw new Error("fixture startup refused");
        const server = http.createServer((_request, response) => response.end("ready"));
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        process.stdout.write("ready:" + attempt + "\\n");
        return {
          getTailscaleIngressEndpoint: () => undefined,
          startupSettled: Promise.resolve(),
          close: () => {
            if (closeFailure === "pending") {
              fileLogTransport.setAppenderForTests(() => {
                process.stdout.write("append:pending\\n");
                return new Promise(() => {});
              });
              process.stdout.write("close:pending\\n");
              return new Promise(() => {});
            }
            if (closeFailure) {
              const error = new TypeError("fixture close owner failed");
              error.stack = "TypeError: fixture close owner failed\\n    at closeOwner (fixture.js:12:3)";
              if (closeFailure === "sync") throw error;
              return Promise.reject(error);
            }
            return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
              .then(() => process.stdout.write("closed:" + attempt + "\\n"));
          },
        };
      },
      runtime: {
        log: () => {},
        error: (...args) => console.error(...args),
        exit: code => process.exit(code),
      },
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
`;

afterEach(async () => {
  for (const child of children.keys()) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  const results = await withTestTimeout(
    Promise.allSettled(children.values()),
    5_000,
    "restart liveness children did not close; retaining their fixture directories",
  );
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) {
    throw new AggregateError(errors, "restart liveness cleanup failed");
  }
  children.clear();
  tempDirs.cleanup();
});

function startFixture(initialFailure = false, closeFailure = "") {
  const directory = tempDirs.make("openclaw-restart-liveness-");
  const home = path.join(directory, "home");
  fs.mkdirSync(home);
  const faultPath = path.join(directory, "startup-fault");
  const logFile = path.join(directory, "gateway.jsonl");
  const stateDir = path.join(directory, "state");
  fs.writeFileSync(
    path.join(directory, "openclaw.json"),
    JSON.stringify({ logging: { level: "info", file: logFile } }),
  );
  if (initialFailure) {
    fs.writeFileSync(faultPath, "refuse");
  }
  const child = spawn(
    process.execPath,
    [
      "--inspect-port=127.0.0.1:0",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      childScript,
      faultPath,
      closeFailure,
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: directory,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
        OPENCLAW_NO_RESPAWN: "1",
        ...(closeFailure === "pending"
          ? { OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway.test" }
          : {}),
        NODE_DISABLE_COMPILE_CACHE: "1",
        TSX_DISABLE_CACHE: "1",
        ESBUILD_WORKER_THREADS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = once(child, "close");
  children.set(child, closed);
  void closed.catch(() => {});
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const waitForOutput = (text: string) =>
    vi.waitFor(() => expect(output).toContain(text), { timeout: 45_000, interval: 25 });
  return { child, closed, faultPath, logFile, stateDir, waitForOutput, output: () => output };
}

async function expectFailedRestartWaiting(
  fixture: ReturnType<typeof startFixture>,
  attempt: number,
) {
  expect(fixture.child.kill("SIGUSR2")).toBe(true);
  await fixture.waitForOutput(`waiting:${attempt}`);
  // Only the parent observes an idle interval. A child timer or IPC channel
  // would hide the lost-process regression after its real listener closes.
  expect(
    await Promise.race([
      fixture.closed.then((exit) => ({ exit })),
      delay(750).then(() => "waiting"),
    ]),
    fixture.output(),
  ).toBe("waiting");
}

describe("runGatewayLoop failed-restart process lifetime", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt(
    "attaches the Node debugger on SIGUSR1 and restarts only on SIGUSR2",
    async () => {
      const fixture = startFixture();
      await fixture.waitForOutput("ready:1");
      expect(fixture.child.kill("SIGUSR1")).toBe(true);
      await fixture.waitForOutput("Debugger listening on ws://127.0.0.1:");
      const inspectorUrl = fixture.output().match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1];
      expect(inspectorUrl).toBeDefined();
      const debuggerSocket = new WebSocket(inspectorUrl!);
      try {
        await once(debuggerSocket, "open");
        const reply = once(debuggerSocket, "message");
        debuggerSocket.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression: "process.pid" },
          }),
        );
        const [data] = await reply;
        expect(JSON.parse(String(data))).toMatchObject({
          id: 1,
          result: { result: { value: fixture.child.pid } },
        });
        expect(fixture.output()).not.toContain("start:2");
      } finally {
        const closed = once(debuggerSocket, "close");
        debuggerSocket.close();
        await closed;
      }
      expect(fixture.child.kill("SIGUSR2")).toBe(true);
      await fixture.waitForOutput("ready:2");
      expect(fixture.child.kill("SIGTERM")).toBe(true);
      expect(await fixture.closed, fixture.output()).toEqual([0, null]);
    },
    60_000,
  );

  it.skipIf(process.platform !== "darwin")(
    "exits before the hard watchdog when a shutdown-deadline log append stalls",
    async () => {
      const fixture = startFixture(false, "pending");
      await fixture.waitForOutput("ready:1");
      expect(fixture.child.kill("SIGTERM")).toBe(true);
      await fixture.waitForOutput("close:pending");
      expect(await fixture.closed, fixture.output()).toEqual([0, null]);
      expect(fixture.output()).toContain("append:pending");
      const bundleDir = path.join(fixture.stateDir, "logs", "stability");
      const files = fs.readdirSync(bundleDir);
      expect(files).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(path.join(bundleDir, files[0]!), "utf8"))).toMatchObject({
        reason: "gateway.stop_shutdown_timeout",
      });
    },
    60_000,
  );

  posixIt.each(["sync", "rejected"])(
    "persists %s close failures before a SIGUSR2 force-exit",
    async (mode) => {
      const fixture = startFixture(false, mode);
      await fixture.waitForOutput("ready:1");
      expect(fixture.child.kill("SIGUSR2")).toBe(true);
      expect(await fixture.closed, fixture.output()).toEqual([1, null]);
      const bundleDir = path.join(fixture.stateDir, "logs", "stability");
      const files = fs.readdirSync(bundleDir);
      expect(files).toHaveLength(1);
      const bundle = JSON.parse(fs.readFileSync(path.join(bundleDir, files[0]!), "utf8"));
      expect(bundle).toMatchObject({
        reason: "gateway.restart_close_failed",
        error: { name: "TypeError", message: "fixture close owner failed" },
        evidence: {
          shutdown: {
            step: "gateway-server-close",
            errors: [
              {
                name: "TypeError",
                message: "fixture close owner failed",
                stack: "TypeError: fixture close owner failed\n    at closeOwner (fixture.js:12:3)",
              },
            ],
          },
        },
      });
      expect(fs.readFileSync(fixture.logFile, "utf8")).toContain(
        "shutdown step failed (gateway server close): fixture close owner failed",
      );
      expect(fixture.output()).not.toContain("start:2");
    },
    60_000,
  );

  posixIt(
    "recovers in the same process after repeated operator-triggered startup failures",
    async () => {
      const fixture = startFixture();
      await fixture.waitForOutput("ready:1");
      fs.writeFileSync(fixture.faultPath, "refuse");
      await expectFailedRestartWaiting(fixture, 2);
      await expectFailedRestartWaiting(fixture, 3);
      fs.unlinkSync(fixture.faultPath);
      expect(fixture.child.kill("SIGUSR2")).toBe(true);
      await fixture.waitForOutput("ready:4");
      expect(fixture.child.kill("SIGTERM")).toBe(true);
      expect(await fixture.closed, fixture.output()).toEqual([0, null]);
    },
    60_000,
  );

  posixIt.each(["SIGTERM", "SIGINT"] as const)(
    "exits cleanly on %s while waiting after a failed restart",
    async (signal) => {
      const fixture = startFixture();
      await fixture.waitForOutput("ready:1");
      fs.writeFileSync(fixture.faultPath, "refuse");
      await expectFailedRestartWaiting(fixture, 2);
      expect(fixture.child.kill(signal)).toBe(true);
      expect(await fixture.closed, fixture.output()).toEqual([0, null]);
      expect(fixture.output()).not.toContain("start:3");
    },
    60_000,
  );

  posixIt(
    "releases process ownership when initial startup rejects",
    async () => {
      const fixture = startFixture(true);
      expect(await fixture.closed, fixture.output()).toEqual([1, null]);
      expect(fixture.output()).toContain("fixture startup refused");
      expect(fixture.output()).not.toContain("Process will stay alive");
    },
    60_000,
  );
});
