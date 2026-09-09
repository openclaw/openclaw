import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it.each([
  { mode: "automatic", exitCode: 0, disposed: true },
  { mode: "requested", exitCode: 7, disposed: false },
  { mode: "deferred", exitCode: 7, disposed: false },
  { mode: "failure", exitCode: 9, disposed: false },
  { mode: "worker", exitCode: 0, disposed: true },
])("preserves native cleanup and the $mode exit policy", ({ mode, exitCode, disposed }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-cleanup-exit-"));
  const databasePath = path.join(directory, "observations.sqlite");
  const exitPath = path.join(directory, "exit.json");
  const oneShotExitUrl = new URL("./one-shot-exit.ts", import.meta.url).href;
  const cleanupUrl = new URL("./runtime-cleanup.ts", import.meta.url).href;
  const runtimeUrl = new URL("../runtime.ts", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    import { setTimeout as delay } from "node:timers/promises";
    import { runCliDisposer } from ${JSON.stringify(cleanupUrl)};
    import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${JSON.stringify(oneShotExitUrl)};
    import { defaultRuntime, ExitError } from ${JSON.stringify(runtimeUrl)};

    const mode = ${JSON.stringify(mode)};
    const database = new DatabaseSync(${JSON.stringify(databasePath)});
    database.exec("CREATE TABLE observations(value INTEGER); INSERT INTO observations VALUES (42)");
    let disposals = 0;
    let returnedBeforeCleanup = false;
    let finalizationReturnedBeforeCleanup = false;
    let reportedErrors = 0;
    process.on("exit", code => {
      fs.writeFileSync(${JSON.stringify(exitPath)}, JSON.stringify({
        code, disposals, nativeOpen: database.isOpen, returnedBeforeCleanup,
        finalizationReturnedBeforeCleanup, reportedErrors,
      }));
    });
    await runCliWithExitFinalization({
      run: async () => {
        try {
          defaultRuntime.writeJson({ mode, outcome: "recorded" });
          if (mode === "requested") requestExitAfterOneShotOutput(defaultRuntime, 7);
          if (mode === "deferred") throw new ExitError(7);
          if (mode === "failure") throw new Error("synthetic command failure");
        } finally {
          await runCliDisposer("native-write", async () => {
            // The referenced timer is the actual cleanup, beyond its reporting grace.
            await delay(6_000);
            database.exec("INSERT INTO observations VALUES (99)");
            database.close();
            disposals++;
          });
          returnedBeforeCleanup = database.isOpen && disposals === 0;
        }
      },
      onError: error => {
        if (error.message !== "synthetic command failure") throw error;
        reportedErrors++;
        process.exitCode = 9;
      },
      env: { NODE_USE_SYSTEM_CA: "1", ...(mode === "worker" ? { VITEST: "1" } : {}) },
      execArgv: [],
      platform: "darwin",
      markers: mode === "worker" ? { tinypoolState: {} } : {},
    });
    finalizationReturnedBeforeCleanup = database.isOpen;
  `;

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: directory,
          USERPROFILE: directory,
          TERM: "dumb",
          NODE_DISABLE_COMPILE_CACHE: "1",
          TSX_DISABLE_CACHE: "1",
        },
        timeout: 20_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(exitCode);
    expect(JSON.parse(result.stdout)).toEqual({ mode, outcome: "recorded" });
    expect(result.stderr).toContain("CLI cleanup timed out: native-write after 5000ms");
    expect(JSON.parse(fs.readFileSync(exitPath, "utf8"))).toEqual({
      code: exitCode,
      disposals: disposed ? 1 : 0,
      nativeOpen: !disposed,
      returnedBeforeCleanup: true,
      finalizationReturnedBeforeCleanup: mode !== "automatic",
      reportedErrors: mode === "failure" ? 1 : 0,
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare("SELECT value FROM observations ORDER BY value").all()).toEqual(
        (disposed ? [42, 99] : [42]).map((value) => ({ value })),
      );
    } finally {
      database.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
