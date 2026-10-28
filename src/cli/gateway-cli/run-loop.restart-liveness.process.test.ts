import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { gatewayDirectStopEntrypoints } from "../cli-entrypoint.test-support.js";
import { createProcessFixtures } from "./run-loop-process.test-support.js";

const fixtures = createProcessFixtures("restart liveness cleanup failed", 5_000);
const moduleUrl = (entry: Parameters<typeof resolveRuntimeWorkerUrl>[0]) =>
  JSON.stringify(resolveRuntimeWorkerUrl(entry).href);

const childScript = `
  import fs, { promises as fsPromises } from "node:fs";
  import http from "node:http";
  import { runGatewayLoop } from ${moduleUrl(gatewayDirectStopEntrypoints.runLoop)};
  import { setGatewayRestartPolicy } from ${moduleUrl(gatewayDirectStopEntrypoints.restartPolicy)};
  import { PluginRuntimeCloseRetainedError } from ${JSON.stringify(new URL("../../plugins/runtime-close-error.ts", import.meta.url).href)};
  const [faultPath, closeFailure, logFile] = process.argv.slice(1);
  setGatewayRestartPolicy({ allowExternal: true });
  let starts = 0;
  try {
    process.once("beforeExit", () => process.stdout.write("natural-exit\\n"));
    process.exitCode = await runGatewayLoop({
      ownsProcessLifecycle: true,
      start: async () => {
        process.stdout.write("start:" + ++starts + "\\n");
        if (fs.existsSync(faultPath)) {
          process.stdout.write("waiting:" + starts + "\\n");
          throw new Error("fixture startup refused");
        }
        const server = http.createServer((_request, response) => response.end("ready"));
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        process.stdout.write("ready:" + starts + "\\n");
        return {
          getTailscaleIngressEndpoint: () => undefined,
          startupSettled: Promise.resolve(),
          close: async () => {
            if (closeFailure === "pending") {
              const openFile = fsPromises.open.bind(fsPromises);
              fsPromises.open = (...args) => {
                if (args[0] === logFile) {
                  process.stdout.write("append:pending\\n");
                  return new Promise(() => {});
                }
                return openFile(...args);
              };
              return new Promise(() => {});
            }
            await new Promise((resolve, reject) => {
              server.close(error => error ? reject(error) : resolve());
            });
            if (closeFailure) {
              const error = new TypeError("fixture close owner failed");
              if (closeFailure === "retained") setInterval(() => {}, 1000);
              throw closeFailure === "retained" ? new PluginRuntimeCloseRetainedError(error) : error;
            }
          },
        };
      },
    });
    process.stdout.write("loop-returned:" + process.exitCode + "\\n");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
`;

function startFixture(initialFailure = false, closeFailure = "", executable = process.execPath) {
  const directory = fixtures.make("openclaw-restart-liveness-");
  const home = fs.mkdtempSync(path.join(directory, "home-"));
  const pendingClose = closeFailure === "pending" || closeFailure === "retained";
  const bin = pendingClose ? fs.mkdtempSync(path.join(directory, "bin-")) : "";
  if (pendingClose) {
    // This fixture owns a short native deadline, independent of the service policy.
    fs.writeFileSync(
      path.join(bin, "launchctl"),
      `#!/bin/sh\nprintf '\\tstate = SIGTERMed\\n\\texit timeout = 10\\n\\tpid = %s\\n' "$(cat "$0.pid")"\n`,
      { mode: 0o755 },
    );
  }
  const faultPath = path.join(directory, "startup-fault");
  const logFile = path.join(directory, "gateway.jsonl");
  const stateDir = path.join(directory, "state");
  const configPath = path.join(directory, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ logging: { level: "info", file: logFile } }));
  if (initialFailure) {
    fs.writeFileSync(faultPath, "refuse");
  }
  const moduleArgs = ["--import", "tsx", "--input-type=module", "--eval"];
  const child = spawn(
    executable,
    ["--inspect-port=127.0.0.1:0", ...moduleArgs, childScript, faultPath, closeFailure, logFile],
    {
      env: {
        PATH: pendingClose ? `${bin}${path.delimiter}${process.env.PATH ?? ""}` : process.env.PATH,
        HOME: home,
        TMPDIR: directory,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_NO_RESPAWN: "1",
        ...(pendingClose ? { OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway.test" } : {}),
        NODE_DISABLE_COMPILE_CACHE: "1",
        TSX_DISABLE_CACHE: "1",
        ESBUILD_WORKER_THREADS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const tracked = fixtures.ownChild(child);
  if (pendingClose) {
    // Native queries may run through the spawn broker, so report the fixture's PID.
    fs.writeFileSync(path.join(bin, "launchctl.pid"), String(child.pid));
  }
  const output = () => tracked.output.stdout + tracked.output.stderr;
  const waitForOutput = (text: string) =>
    vi.waitFor(() => expect(output()).toContain(text), { timeout: 45_000, interval: 25 });
  return { ...tracked, faultPath, logFile, stateDir, waitForOutput, output };
}

async function expectRestartWaiting(fixture: ReturnType<typeof startFixture>, attempt: number) {
  expect(fixture.child.kill("SIGUSR2")).toBe(true);
  await fixture.waitForOutput(`waiting:${attempt}`);
  // Only the parent observes an idle interval. A child timer or IPC channel
  // would hide the lost-process regression after its real listener closes.
  expect(await Promise.race([fixture.closed, delay(750, "waiting")]), fixture.output()).toBe(
    "waiting",
  );
}

function readStabilityBundle(fixture: ReturnType<typeof startFixture>, reason?: string) {
  const directory = path.join(fixture.stateDir, "logs", "stability");
  const files = fs
    .readdirSync(directory)
    .filter((file) => !reason || file.endsWith(`-${reason}.json`));
  expect(files).toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(directory, files[0]!), "utf8"));
}

describe("runGatewayLoop failed-restart process lifetime", { timeout: 60_000 }, () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt("attaches the Node debugger on SIGUSR1 and restarts only on SIGUSR2", async () => {
    const fixture = startFixture(false, "", resolveTestNodeExecPath());
    await fixture.waitForOutput("ready:1");
    expect(fixture.child.kill("SIGUSR1")).toBe(true);
    await fixture.waitForOutput("Debugger listening on ws://127.0.0.1:");
    expect(fixture.output()).not.toContain("start:2");
    expect(fixture.child.kill("SIGUSR2")).toBe(true);
    await fixture.waitForOutput("ready:2");
    expect(fixture.child.kill("SIGTERM")).toBe(true);
    expect(await fixture.closed, fixture.output()).toEqual([0, null]);
    expect(fixture.output()).toContain("natural-exit");
  });

  posixIt.each(
    process.platform === "darwin"
      ? ["pending", "rejected", "retained", "retained-stop"]
      : ["rejected"],
  )("terminates failed native cleanup (%s)", async (mode) => {
    const pending = mode === "pending";
    const stop = pending || mode === "retained-stop";
    const retained = mode.startsWith("retained");
    const fixture = startFixture(false, retained ? "retained" : mode);
    await fixture.waitForOutput("ready:1");
    expect(fixture.child.kill(stop ? "SIGTERM" : "SIGUSR2")).toBe(true);
    const exited = await Promise.race([fixture.closed, delay(12_000, "still alive")]);
    expect(exited, fixture.output()).toEqual(mode === "rejected" ? [1, null] : [null, "SIGKILL"]);
    expect(fixture.output().includes("natural-exit")).toBe(mode === "rejected");
    const reason = pending
      ? "gateway.stop_shutdown_timeout"
      : stop
        ? "gateway.stop_close_failed"
        : "gateway.restart_close_failed";
    const bundle = readStabilityBundle(fixture, reason);
    expect(bundle.reason).toBe(reason);
    if (pending) {
      expect(fixture.output()).not.toContain("loop-returned:");
      expect(fixture.output()).toContain("append:pending");
    } else {
      expect(bundle.evidence.shutdown.step).toBe("gateway-server-close");
    }
    expect(fixture.output()).not.toContain("start:2");
  });

  posixIt.each([true, false])("holds failed-restart ownership: recovery=%s", async (recover) => {
    const fixture = startFixture();
    await fixture.waitForOutput("ready:1");
    fs.writeFileSync(fixture.faultPath, "refuse");
    await expectRestartWaiting(fixture, 2);
    if (recover) {
      await expectRestartWaiting(fixture, 3);
      fs.unlinkSync(fixture.faultPath);
      expect(fixture.child.kill("SIGUSR2")).toBe(true);
      await fixture.waitForOutput("ready:4");
    }
    expect(fixture.child.kill("SIGTERM")).toBe(true);
    expect(await fixture.closed, fixture.output()).toEqual([0, null]);
    if (!recover) {
      expect(fixture.output()).not.toContain("start:3");
    }
  });

  posixIt("releases process ownership when initial startup rejects", async () => {
    const fixture = startFixture(true);
    expect(await fixture.closed, fixture.output()).toEqual([1, null]);
    expect(fixture.output()).toContain("fixture startup refused");
  });
});
