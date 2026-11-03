import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

it.concurrent.for([
  { mode: "complete", exitCode: 0, disposed: true },
  { mode: "requested", exitCode: 7, disposed: true },
  { mode: "deferred", exitCode: 7, disposed: true },
  { mode: "failure", exitCode: 9, disposed: true },
  { mode: "runtime", exitCode: 7, disposed: true },
])(
  "joins native cleanup and preserves the $mode outcome",
  async ({ mode, exitCode, disposed }, { expect, signal, onTestFinished }) => {
    const fixture = createFixtureLifetime();
    onTestFinished(() => fixture.cleanup());
    await fixture.run(async () => {
      const directory = fixture.createTempDir("openclaw-cli-cleanup-exit-");
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
          if (mode === "runtime") defaultRuntime.exit(7);
          if (mode === "failure") throw new Error("synthetic command failure");
        } finally {
          await runCliDisposer("native-write", async () => {
            // The referenced timer is the actual cleanup, beyond its reporting grace.
            await delay(150);
            database.exec("INSERT INTO observations VALUES (99)");
            database.close();
            disposals++;
          }, undefined, 100);
          returnedBeforeCleanup = database.isOpen && disposals === 0;
        }
      },
      onError: error => {
        if (error.message !== "synthetic command failure") throw error;
        reportedErrors++;
        process.exitCode = 9;
      },
    });
    finalizationReturnedBeforeCleanup = database.isOpen;
  `;

      let child: ChildProcess | undefined;
      const result = await fixture.track(
        runNodeScript(
          [
            "--disable-warning=ExperimentalWarning",
            "--import",
            "tsx",
            "--input-type=module",
            "--eval",
            script,
          ],
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
          {
            signal,
            maxBuffer: 1024 * 1024,
            onReady: (startedChild) => {
              child = startedChild;
            },
          },
        ),
      );
      expect(result.error).toBeUndefined();
      expect(child?.signalCode).toBeNull();
      expect(result.status).toBe(exitCode);
      expect(JSON.parse(result.stdout)).toEqual({ mode, outcome: "recorded" });
      expect(result.stderr).toContain("CLI cleanup timed out: native-write after 100ms");
      expect(JSON.parse(fs.readFileSync(exitPath, "utf8"))).toEqual({
        code: exitCode,
        disposals: disposed ? 1 : 0,
        nativeOpen: !disposed,
        returnedBeforeCleanup: true,
        finalizationReturnedBeforeCleanup: false,
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
    });
  },
);

it.for([
  { leak: false, exitCode: 0, status: 0, signal: null, terminated: false },
  { leak: true, exitCode: 0, status: 143, signal: "SIGTERM", terminated: true },
  // A non-zero status can be a supervisor's restart instruction, so it is only reported.
  { leak: true, exitCode: 7, status: 7, signal: null, terminated: false },
])(
  "bounds a leaked handle after settled finalization (leak=$leak, exitCode=$exitCode)",
  async ({ leak, exitCode, status, signal: expectedSignal, terminated }, { expect, signal }) => {
    if (terminated && process.platform === "win32") {
      return;
    }
    const script = `
      import { createServer } from "node:net";
      import { setTimeout as delay } from "node:timers/promises";
      import { requestSettledExitWatchdog, runCliWithExitFinalization } from ${JSON.stringify(new URL("./one-shot-exit.ts", import.meta.url).href)};
      process.on("SIGTERM", () => {});
      if (${leak}) {
        const server = createServer().listen(0, "127.0.0.1");
        // The leak outlives the watchdog; only an unterminated child closes it later.
        setTimeout(() => server.close(), 1_500).unref();
      }
      await runCliWithExitFinalization({
        run: async () => {
          process.exitCode = ${exitCode};
          requestSettledExitWatchdog(200);
        },
        // Finalization longer than the watchdog proves it is armed only afterwards.
        finalize: async () => {
          await delay(400);
          process.stdout.write("finalized\\n");
        },
        onError: (error) => { throw error; },
      });
    `;
    let child: ChildProcess | undefined;
    const result = await runNodeScript(
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        NODE_DISABLE_COMPILE_CACHE: "1",
        TSX_DISABLE_CACHE: "1",
      },
      5_000,
      {
        signal,
        onReady: (started) => {
          child = started;
        },
      },
    );
    const diagnostics = JSON.stringify(result);
    expect(result.error, diagnostics).toBeUndefined();
    expect(result.stdout, diagnostics).toContain("finalized");
    expect(child?.signalCode, diagnostics).toBe(expectedSignal);
    expect(result.status, diagnostics).toBe(status);
    if (leak) {
      // Resource names are runtime diagnostics; Bun reports fewer handle types than Node.
      expect(result.stderr, diagnostics).toContain(
        "command settled but the process is still alive after 200ms; active resources:",
      );
      expect(result.stderr.includes("; terminating"), diagnostics).toBe(terminated);
    } else {
      expect(result.stderr, diagnostics).not.toContain("still alive");
    }
  },
);
