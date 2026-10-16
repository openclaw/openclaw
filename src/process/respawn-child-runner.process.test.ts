import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { CLI_PARENT_BOUND_PRELOAD } from "../../cli-parent-lifetime.mjs";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

it.each(["complete", "parent-bound"] as const)(
  "respawn lifetime preserves %s completion",
  async (lifetime) => {
    const source = `
      import { watchCliRespawnParent } from ${JSON.stringify(new URL("../../cli-parent-lifetime.mjs", import.meta.url).href)};
      watchCliRespawnParent();
      const timer = ${lifetime === "complete" ? "undefined" : "setInterval(() => {}, 1000)"};
      process.once("SIGTERM", () => { clearInterval(timer); process.stdout.write("settled"); });

      process.send("ready");
    `;
    const child = spawn(
      resolveTestNodeExecPath(),
      ["--import", CLI_PARENT_BOUND_PRELOAD, "--input-type=module", "-e", source],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    const exited = once(child, "exit");
    try {
      expect((await once(child, "message"))[0]).toBe("ready");
      if (lifetime === "parent-bound") {
        child.disconnect();
      }
      expect(await exited).toEqual([0, null]);
      expect(stdout).toBe(lifetime === "parent-bound" ? "settled" : "");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await exited;
    }
  },
);

it.runIf(process.platform !== "win32").each([
  { owner: "entry", signal: true },
  { owner: "entry", signal: false },
  { owner: "launcher", signal: true },
  { owner: "launcher", signal: false },
])(
  "preserves real $owner child-only signal versus numeric completion (signal=$signal)",
  ({ owner, signal }) => {
    const child = signal
      ? "process.stdout.write('settled-output', () => process.kill(process.pid, 'SIGKILL'));"
      : "process.stdout.write('settled-output'); process.exitCode = 143;";
    const source =
      owner === "entry"
        ? "import {spawn} from 'node:child_process';" +
          "import {attachChildProcessBridge} from " +
          JSON.stringify(new URL("./child-process-bridge.ts", import.meta.url).href) +
          ";" +
          "import {runRespawnChildWithSignalBridge} from " +
          JSON.stringify(new URL("./respawn-child-runner.ts", import.meta.url).href) +
          ";" +
          "process.exitCode = await runRespawnChildWithSignalBridge({command:process.execPath,args:['-e'," +
          JSON.stringify(child) +
          "],env:{},runtime:{spawn,attachChildProcessBridge},onError:console.error});"
        : "import {runRespawnedChild} from " +
          JSON.stringify(new URL("../../node-runtime-recovery.mjs", import.meta.url).href) +
          ";" +
          "await runRespawnedChild(process.execPath,['-e'," +
          JSON.stringify(child) +
          "],{});";
    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", source],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe("settled-output");
    expect({ code: result.status, signal: result.signal }, result.stderr).toEqual(
      signal ? { code: null, signal: "SIGKILL" } : { code: 143, signal: null },
    );
  },
);
