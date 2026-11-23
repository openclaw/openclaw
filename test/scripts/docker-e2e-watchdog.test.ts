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
        `import assert from 'node:assert/strict';
        const { runWatchdog } = await import(${JSON.stringify(pathToFileURL(watchdogPath).href)});
        assert.equal(typeof runWatchdog, 'function');`,
      ],
      { encoding: "utf8", env, timeout: 5_000 },
    );
    expect(importResult.error).toBeUndefined();
    expect(importResult.status, importResult.stderr).toBe(0);
    expect(importResult.stdout).toBe("");
    expect(importResult.stderr).toBe("");
  });

  it("arms the timeout the CLI duration names", () => {
    const watchdogUrl = pathToFileURL(path.resolve("scripts/lib/docker-e2e-watchdog.mjs")).href;
    // Files, not `-e` flags: the Bun lane runs this test with Bun as process.execPath.
    const root = harness.createTempDir("openclaw-watchdog-durations-");
    const child = path.join(root, "child.mjs");
    const probe = path.join(root, "probe.mjs");
    fs.writeFileSync(child, "");
    // Record the armed delay; the trivial child exits first and settles the watchdog.
    fs.writeFileSync(
      probe,
      `
      const delays = [];
      const setTimer = globalThis.setTimeout;
      globalThis.setTimeout = (callback, ms, ...rest) => {
        delays.push(ms);
        return setTimer(callback, ms, ...rest);
      };
      process.on("exit", () => console.log(JSON.stringify(delays[0])));
      const { runWatchdog } = await import(${JSON.stringify(watchdogUrl)});
      await runWatchdog("e2e", process.argv[2], [process.execPath, ${JSON.stringify(child)}]);
    `,
    );
    const run = (value: string) =>
      spawnSync(process.execPath, [probe, value], {
        encoding: "utf8",
        env: testRunnerFixtureEnv(),
        timeout: 5_000,
      });
    for (const [value, ms] of [
      ["900s", 900_000],
      ["1.5s", 1_500],
      ["0", 1],
      ["2m", 120_000],
      ["0.01ms", 1],
      ["1h", 3_600_000],
      ["7", 7_000],
    ] as const) {
      expect(run(value).stdout.trim(), value).toBe(String(ms));
    }
    const invalid = run("invalid");
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("unsupported timeout value: invalid");
  });
});
