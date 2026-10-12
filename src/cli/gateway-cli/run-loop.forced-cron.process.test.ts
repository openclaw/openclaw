import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
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
    await Promise.all(children.values());
    children.clear();
    cleanup();
  }),
);
const fixture = resolveRuntimeWorkerUrl(gatewayDirectStopEntrypoints.forcedCronFixture);

it.skipIf(process.platform === "win32").for([
  { signal: "SIGUSR2", mode: "force" },
  { signal: "SIGTERM", mode: "force" },
  { signal: "SIGUSR2", mode: "timeout" },
] as const)(
  "settles admitted cron work before $signal $mode restart",
  { timeout: 60_000 },
  async ({ signal, mode }, { signal: testSignal }) => {
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
    const waitForOutput = async (text: string) => {
      let inspect: () => void = () => {};
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            new Promise<void>((resolve) => {
              inspect = () => {
                if (output.includes(text)) {
                  resolve();
                }
              };
              changes.on("output", inspect);
              inspect();
            }),
            closed,
            `Missing ${text}`,
          ),
          testSignal,
        );
      } catch (cause) {
        throw new Error(`Missing ${text}: ${output}`, { cause });
      } finally {
        changes.off("output", inspect);
      }
    };
    await waitForOutput("process proof: ready:1");
    expect(child.kill(signal)).toBe(true);
    if (mode === "timeout") {
      await waitForOutput("process proof: cron-cancelled:Gateway restarting.");
      await waitForOutput("process proof: close-entered");
    } else {
      await waitForOutput("draining active work before");
      expect(output).not.toContain("process proof: close-entered");
    }
    child.send("inspect");
    await waitForOutput("process proof: held:starts=1:connectionPending=false:cronPending=1");
    expect(fs.existsSync(path.join(root, "cleanup.txt"))).toBe(false);
    expect(output).not.toContain("process proof: close-completed");
    expect(output).not.toContain("process proof: ready:2");
    expect(child.exitCode).toBeNull();
    child.send("release");
    if (signal === "SIGUSR2") {
      await waitForOutput("process proof: ready:2");
      expect(child.kill("SIGINT")).toBe(true);
    }
    const outcome = await withinTest(closed, testSignal).catch((cause: unknown) => {
      throw new Error(output, { cause });
    });
    expect(outcome).toEqual([0, null]);
    expect(fs.readFileSync(path.join(root, "cleanup.txt"), "utf8")).toBe("settled\n");
    expect(output.indexOf("process proof: cron-cleanup-settled")).toBeLessThan(
      output.indexOf("process proof: close-completed"),
    );
    expect(output).not.toContain("shutdown deadline reached");
  },
);
