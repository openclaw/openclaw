import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { gatewayDirectStopEntrypoints } from "../cli-entrypoint.test-support.js";

const children = new Map<ChildProcess, Promise<unknown[]>>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const child of children.keys()) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    await withTestTimeout(
      Promise.all(children.values()),
      5_000,
      "cron restart children did not close",
    );
    children.clear();
    cleanup();
  }),
);
const fixture = resolveRuntimeWorkerUrl(gatewayDirectStopEntrypoints.forcedCronFixture);

it.skipIf(process.platform === "win32").each([
  { signal: "SIGUSR2", mode: "force" },
  { signal: "SIGTERM", mode: "force" },
  { signal: "SIGUSR2", mode: "timeout" },
] as const)(
  "settles admitted cron work before $signal $mode restart",
  async ({ signal, mode }) => {
    const root = tempDirs.make("openclaw-forced-cron-");
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    const child = spawn(process.execPath, [...resolveRuntimeWorkerArgv(fixture), root, mode], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_NO_RESPAWN: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
        TSX_DISABLE_CACHE: "1",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const closed = once(child, "close");
    children.set(child, closed);
    void closed.catch(() => {});
    let output = "";
    const changes = new EventEmitter();
    const recordOutput = (chunk: Buffer) => {
      output += chunk.toString();
      changes.emit("output");
    };
    child.stdout?.on("data", recordOutput);
    child.stderr?.on("data", recordOutput);
    const waitForOutput = async (text: string, timeout = 5_000) => {
      let inspect: () => void = () => {};
      try {
        await withTestTimeout(
          new Promise<void>((resolve) => {
            inspect = () => {
              if (output.includes(text)) {
                resolve();
              }
            };
            changes.on("output", inspect);
            inspect();
          }),
          timeout,
          `Missing ${text}: ${output}`,
        );
      } finally {
        changes.off("output", inspect);
      }
    };
    await waitForOutput("process proof: ready:1", 45_000);
    expect(child.kill(signal)).toBe(true);
    if (mode === "timeout") {
      await waitForOutput("process proof: cron-cancelled:Gateway restarting.");
      await waitForOutput("process proof: close-entered");
    } else {
      await waitForOutput("draining active work before");
      expect(output).not.toContain("process proof: close-entered");
    }
    child.send("inspect");
    await waitForOutput("process proof: held:starts=1:pending=true");
    expect(fs.existsSync(path.join(root, "cleanup.txt"))).toBe(false);
    expect(output).not.toContain("process proof: close-completed");
    expect(output).not.toContain("process proof: ready:2");
    expect(child.exitCode).toBeNull();
    child.send("release");
    if (signal === "SIGUSR2") {
      await waitForOutput("process proof: ready:2", 15_000);
      expect(child.kill("SIGINT")).toBe(true);
    }
    const outcome = await withTestTimeout(closed, 5_000, "Cron restart child did not close").catch(
      (cause: unknown) => {
        throw new Error(output, { cause });
      },
    );
    expect(outcome).toEqual([0, null]);
    expect(fs.readFileSync(path.join(root, "cleanup.txt"), "utf8")).toBe("settled\n");
    expect(output.indexOf("process proof: cron-cleanup-settled")).toBeLessThan(
      output.indexOf("process proof: close-completed"),
    );
    expect(output).not.toContain("shutdown deadline reached");
  },
  60_000,
);
