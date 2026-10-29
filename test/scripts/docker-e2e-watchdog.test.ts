import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";

const harness = createScriptTestHarness();

describe("docker E2E watchdog entrypoint", () => {
  it("dispatches once through a path alias in both Node symlink modes and stays inert when imported", () => {
    const root = harness.createTempDir("openclaw-watchdog-entrypoint-");
    const physicalRoot = path.join(root, "physical");
    const logicalRoot = path.join(root, "logical");
    const physicalLib = path.join(physicalRoot, "scripts", "lib");
    fs.mkdirSync(physicalLib, { recursive: true });
    for (const file of ["direct-run.mjs", "docker-e2e-watchdog.mjs"]) {
      fs.copyFileSync(path.join("scripts", "lib", file), path.join(physicalLib, file));
    }
    fs.symlinkSync(physicalRoot, logicalRoot, process.platform === "win32" ? "junction" : "dir");

    const watchdogPath = path.join(logicalRoot, "scripts", "lib", "docker-e2e-watchdog.mjs");
    const childSource = `
      import fs from "node:fs";
      fs.appendFileSync(process.argv[1], "ran\\n");
      process.exit(Number(process.argv[2]));
    `;
    const env = testRunnerFixtureEnv();

    for (const preserveSymlinksMain of [false, true]) {
      for (const expectedStatus of [0, 23]) {
        const mode = preserveSymlinksMain ? "preserved" : "resolved";
        const marker = path.join(root, `child-${mode}-${expectedStatus}.log`);
        const result = spawnSync(
          process.execPath,
          [
            ...(preserveSymlinksMain ? ["--preserve-symlinks-main"] : []),
            watchdogPath,
            "e2e",
            "5s",
            process.execPath,
            "--input-type=module",
            "-e",
            childSource,
            marker,
            String(expectedStatus),
          ],
          { encoding: "utf8", env, timeout: 5_000 },
        );

        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(expectedStatus);
        expect(fs.readFileSync(marker, "utf8")).toBe("ran\n");
      }
    }

    const importResult = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(watchdogPath).href)});`,
      ],
      { encoding: "utf8", env, timeout: 5_000 },
    );
    expect(importResult.error).toBeUndefined();
    expect(importResult.status, importResult.stderr).toBe(0);
    expect(importResult.stdout).toBe("");
    expect(importResult.stderr).toBe("");
  });
});
