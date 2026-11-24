import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

it.runIf(process.platform === "linux")(
  "adds no filesystem calls for DrvFS recovery on an ordinary Linux filesystem",
  () => {
    const executables = new Set([resolveTestNodeExecPath(), process.execPath]);
    for (const executable of executables) {
      const result = spawnSync(
        executable,
        [path.resolve("test/fixtures/fs-safe-drvfs-calls.mjs"), process.cwd()],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const observation = JSON.parse(result.stdout);
      expect(observation.physical.platform).toBe("linux");
      expect(
        observation.rows.filter((row: { phase: string }) => row.phase === "warm"),
      ).toHaveLength(12);
      console.log(result.stdout.trim());
    }
  },
);
