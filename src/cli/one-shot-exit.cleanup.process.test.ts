import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

it.concurrent.for([
  { mode: "complete", exitCode: 0 },
  { mode: "requested", exitCode: 7 },
  { mode: "deferred", exitCode: 7 },
  { mode: "failure", exitCode: 9 },
  { mode: "runtime", exitCode: 7 },
])(
  "joins native cleanup and preserves the $mode outcome",
  async ({ mode, exitCode }, { expect, signal, onTestFinished }) => {
    const fixture = createFixtureLifetime();
    onTestFinished(() => fixture.cleanup());
    await fixture.run(async () => {
      const directory = fixture.createTempDir("openclaw-cli-cleanup-exit-");
      const databasePath = path.join(directory, "observations.sqlite");
      const exitPath = path.join(directory, "exit.json");
      const script = `
    import fs from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    import { setTimeout as delay } from "node:timers/promises";
    import { runCliDisposer } from ${JSON.stringify(new URL("./runtime-cleanup.ts", import.meta.url).href)};
    import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${JSON.stringify(new URL("./one-shot-exit.ts", import.meta.url).href)};
    import { defaultRuntime, ExitError } from ${JSON.stringify(new URL("../runtime.ts", import.meta.url).href)};

    const mode = ${JSON.stringify(mode)};
    const database = new DatabaseSync(${JSON.stringify(databasePath)});
    database.exec("CREATE TABLE observations(value INTEGER); INSERT INTO observations VALUES (42)");
    const observed = { disposals: 0, returnedBeforeCleanup: false,
      finalizationReturnedBeforeCleanup: false, reportedErrors: 0 };
    process.on("exit", code => fs.writeFileSync(${JSON.stringify(exitPath)},
      JSON.stringify({ code, ...observed, nativeOpen: database.isOpen })));
    await runCliWithExitFinalization({
      run: async () => {
        try {
          defaultRuntime.writeJson({ mode, outcome: "recorded" });
          if (mode === "requested") requestExitAfterOneShotOutput(defaultRuntime, 7);
          if (mode === "deferred") throw new ExitError(7);
          if (mode === "runtime") defaultRuntime.exit(7);
          if (mode === "failure") throw new Error("synthetic command failure");
        } finally {
          await runCliDisposer("native-write", async () => {
            // The referenced timer is the actual cleanup, beyond its reporting grace.
            await delay(150);
            database.exec("INSERT INTO observations VALUES (99)");
            database.close();
            observed.disposals++;
          }, undefined, 100);
          observed.returnedBeforeCleanup = database.isOpen && observed.disposals === 0;
        }
      },
      onError: error => {
        if (error.message !== "synthetic command failure") throw error;
        observed.reportedErrors++;
        process.exitCode = 9;
      },
    });
    observed.finalizationReturnedBeforeCleanup = database.isOpen;
  `;

      const result = await fixture.track(
        runNodeScript(
          ["--import=tsx", "--input-type=module", "--eval", script],
          {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: directory,
            USERPROFILE: directory,
            TERM: "dumb",
            NODE_DISABLE_COMPILE_CACHE: "1",
            TSX_DISABLE_CACHE: "1",
          },
          20_000,
          { signal, maxBuffer: 1024 * 1024 },
        ),
      );
      expect(result).toMatchObject({ error: undefined, status: exitCode });
      expect(JSON.parse(result.stdout)).toEqual({ mode, outcome: "recorded" });
      expect(result.stderr).toContain("CLI cleanup timed out: native-write after 100ms");
      expect(JSON.parse(fs.readFileSync(exitPath, "utf8"))).toEqual({
        code: exitCode,
        disposals: 1,
        nativeOpen: false,
        returnedBeforeCleanup: true,
        finalizationReturnedBeforeCleanup: false,
        reportedErrors: mode === "failure" ? 1 : 0,
      });
      using database = new DatabaseSync(databasePath, { readOnly: true });
      const rows = database.prepare("SELECT value FROM observations ORDER BY value").all();
      expect(rows).toEqual([{ value: 42 }, { value: 99 }]);
    });
  },
);
