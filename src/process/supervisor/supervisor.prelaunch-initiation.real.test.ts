import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createProcessSupervisor } from "./supervisor.js";
import type { SpawnInput } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Exec's assertCurrent() rethrows a fetch-timeout abort reason with this shape.
function initiationTimeout() {
  const error = new Error("request timed out");
  error.name = "TimeoutError";
  return error;
}

function ownedTreeSpawn(cwd: string, script: string, initiateSpawn?: SpawnInput["initiateSpawn"]) {
  return {
    mode: "child",
    argv: [process.execPath, "-e", script],
    cwd,
    stdinMode: "pipe-closed",
    timeoutMs: 10_000,
    // Host exec sets a memory limit, which routes through the owned-tree service-child relay.
    memoryLimitBytes: 2 * 1024 * 1024 * 1024,
    ...(initiateSpawn ? { initiateSpawn } : {}),
  } satisfies SpawnInput;
}

it.skipIf(process.platform === "win32")(
  "a launch refused before initiation does not fence a later shutdown",
  async () => {
    const cwd = tempDirs.make("openclaw-prelaunch-initiation-");
    const ran = path.join(cwd, "ran");
    const supervisor = createProcessSupervisor();
    let launches = 0;

    const refused = supervisor.spawn(
      ownedTreeSpawn(cwd, `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "1")`, () => {
        throw initiationTimeout();
      }),
    );
    await expect(refused).rejects.toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });
    expect(existsSync(ran)).toBe(false);

    // Later work proceeds normally; the earlier refusal must not surface at close.
    const run = await supervisor.spawn(
      ownedTreeSpawn(cwd, "process.exit(0)", (launch) => {
        launches++;
        return launch();
      }),
    );
    await expect(run.wait()).resolves.toMatchObject({ reason: "exit", exitCode: 0 });
    expect(launches).toBe(1);
    // Shutdown joins every owned run's confirmed extinction, so resolving here also
    // proves the refused relay retired through its closing receipt.
    await expect(supervisor.shutdown()).resolves.toBeUndefined();
    expect(existsSync(ran)).toBe(false);
  },
  15_000,
);

it.skipIf(process.platform === "win32")(
  "a refusal after the launch frame was written keeps the supervisor fenced",
  async () => {
    const cwd = tempDirs.make("openclaw-postlaunch-initiation-");
    const supervisor = createProcessSupervisor();

    await expect(
      supervisor.spawn(
        ownedTreeSpawn(cwd, "setTimeout(() => {}, 200)", (launch) => {
          launch();
          throw initiationTimeout();
        }),
      ),
    ).rejects.toThrow("service child cleanup identity lost: TimeoutError: request timed out");
    await expect(supervisor.shutdown()).rejects.toThrow("cleanup identity lost");
  },
  15_000,
);
