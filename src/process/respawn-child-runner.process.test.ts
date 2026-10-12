import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

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
