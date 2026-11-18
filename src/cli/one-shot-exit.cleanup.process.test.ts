import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { doctorConfigRuntimeEntrypoints } from "../commands/doctor-config-runtime.test-support.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { storageProcessTestEntrypoints } from "../infra/storage-process-runtime.test-support.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  cliMessageExitEntrypoints,
  gatewayDirectStopEntrypoints,
} from "./cli-entrypoint.test-support.js";

it("retires a real retained SQLite snapshot before a one-shot command exits", async ({
  expect,
  signal,
  onTestFinished,
}) => {
  const fixture = createFixtureLifetime();
  onTestFinished(() => fixture.cleanup());
  await fixture.run(async () => {
    const directory = fixture.createTempDir("openclaw-cli-snapshot-exit-");
    const databasePath = path.join(directory, "source.sqlite");
    const source = new DatabaseSync(databasePath);
    source.exec("CREATE TABLE observations(value INTEGER); INSERT INTO observations VALUES (42)");
    source.close();
    const originalBytes = fs.readFileSync(databasePath);
    const script = `
      import fs from "node:fs";
      import { DatabaseSync } from "node:sqlite";
      import { startSqliteReadOnlyLocationAsync } from ${JSON.stringify(resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.sqliteSnapshotSource).href)};
      import { closeCliResources } from ${JSON.stringify(resolveRuntimeWorkerUrl(cliMessageExitEntrypoints.cleanup).href)};
      import { runCliWithExitFinalization } from ${JSON.stringify(resolveRuntimeWorkerUrl(cliMessageExitEntrypoints.oneShotExit).href)};
      import { defaultRuntime } from ${JSON.stringify(resolveRuntimeWorkerUrl(doctorConfigRuntimeEntrypoints.runtime).href)};

      await runCliWithExitFinalization({
        run: async () => {
          const snapshot = await startSqliteReadOnlyLocationAsync(
            ${JSON.stringify(databasePath)}, { preserveSourceArtifacts: true },
          ).result;
          const reader = new DatabaseSync(snapshot.location, { readOnly: true });
          const result = reader.prepare("SELECT value FROM observations").get();
          reader.close();
          if (!snapshot.cleanupRoot || !fs.existsSync(snapshot.location)) {
            throw new Error("No retained snapshot was prepared");
          }
          defaultRuntime.writeJson({ value: result.value, snapshotRoot: snapshot.cleanupRoot });
        },
        finalize: closeCliResources,
        onError: error => { throw error; },
      });
    `;
    const result = await fixture.track(
      runNodeScript(
        ["--input-type=module", "--eval", script],
        {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: directory,
          USERPROFILE: directory,
          OPENCLAW_STATE_DIR: path.join(directory, "state"),
          TERM: "dumb",
        },
        20_000,
        { signal, maxBuffer: 1024 * 1024 },
      ),
    );
    expect(result).toMatchObject({ error: undefined, status: 0 });
    const output = JSON.parse(result.stdout);
    expect(output.value).toBe(42);
    expect(path.isAbsolute(output.snapshotRoot)).toBe(true);
    expect(fs.existsSync(output.snapshotRoot)).toBe(false);
    expect(fs.readFileSync(databasePath)).toEqual(originalBytes);
  });
});

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
    import { runCliDisposer } from ${JSON.stringify(resolveRuntimeWorkerUrl(cliMessageExitEntrypoints.cleanup).href)};
    import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${JSON.stringify(resolveRuntimeWorkerUrl(cliMessageExitEntrypoints.oneShotExit).href)};
    import { defaultRuntime, ExitError } from ${JSON.stringify(resolveRuntimeWorkerUrl(doctorConfigRuntimeEntrypoints.runtime).href)};

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
          ["--input-type=module", "--eval", script],
          {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: directory,
            USERPROFILE: directory,
            TERM: "dumb",
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

it.for([
  { leak: false, exitCode: 0, status: 0, signal: null, terminated: false },
  { leak: true, exitCode: 0, status: null, signal: "SIGTERM", terminated: true },
  // A non-zero status can be a supervisor's restart instruction, so it is only reported.
  { leak: true, exitCode: 7, status: 7, signal: null, terminated: false },
  { leak: true, exitCode: 7, status: null, signal: "SIGTERM", terminated: true, oneShot: true },
])(
  "bounds a leaked handle after settled finalization (leak=$leak, exitCode=$exitCode, oneShot=$oneShot)",
  ({ leak, exitCode, status, signal, terminated, oneShot }, { expect }) => {
    if (terminated && process.platform === "win32") {
      return;
    }
    const detailedLeak = leak && exitCode === 7 && !oneShot;
    const script = `
      import { spawn } from "node:child_process";
      import { createServer } from "node:net";
      import { connect, createServer as createTlsServer } from "node:tls";
      import { setTimeout as delay } from "node:timers/promises";
      import { requestOneShotSettledExitWatchdog, requestSettledExitWatchdog, runCliWithExitFinalization } from ${JSON.stringify(resolveRuntimeWorkerUrl(cliMessageExitEntrypoints.oneShotExit).href)};
      process.on("SIGTERM", () => {});
      if (${leak}) {
        const server = (${detailedLeak} ? createTlsServer({ key: ${JSON.stringify(TEST_TLS_KEY_PEM)}, cert: ${JSON.stringify(TEST_TLS_CERT_PEM)} }, socket => socket.resume()) : createServer()).listen(0, "127.0.0.1");
        let tls, child;
        if (${detailedLeak}) {
          await new Promise(resolve => server.once("listening", resolve));
          tls = connect({ host: "127.0.0.1", port: server.address().port, servername: "exit-probe.test", rejectUnauthorized: false });
          await new Promise(resolve => tls.once("secureConnect", resolve));
          child = spawn(process.execPath, ["-e", "process.stdin.resume()", "private-child-argument"], {
            argv0: "exit-child\\n" + "x".repeat(300), stdio: ["pipe", "ignore", "ignore"],
          });
        }
        // The leak outlives the watchdog; only an unterminated child closes it later.
        setTimeout(() => { tls?.destroy(); child?.stdin.end(); server.close(); }, 1_500).unref();
      }
      await runCliWithExitFinalization({
        run: async () => {
          process.exitCode = ${exitCode};
          ${oneShot ? "requestOneShotSettledExitWatchdog" : "requestSettledExitWatchdog"}(200);
        },
        // Finalization longer than the watchdog proves it is armed only afterwards.
        finalize: async () => {
          await delay(400);
          process.stdout.write("finalized\\n");
        },
        onError: (error) => { throw error; },
      });
    `;
    const result = spawnSync(
      detailedLeak ? resolveTestNodeExecPath() : process.execPath,
      ["--input-type=module", "--eval", script],
      {
        encoding: "utf8",
        env: { ...process.env, VITEST: undefined },
        killSignal: "SIGKILL",
        timeout: 5_000,
      },
    );
    const diagnostics = JSON.stringify(result);
    expect(result.error, diagnostics).toBeUndefined();
    expect(result.stdout, diagnostics).toContain("finalized");
    expect(result.signal, diagnostics).toBe(signal);
    expect(result.status, diagnostics).toBe(status);
    if (leak) {
      // Resource names are runtime diagnostics; Bun reports fewer handle types than Node.
      expect(result.stderr, diagnostics).toContain(
        "command settled but the process is still alive after 200ms; active resources:",
      );
      expect(result.stderr, diagnostics).toContain("; active handles:");
      expect(result.stderr.includes("; terminating"), diagnostics).toBe(terminated);
      if (detailedLeak) {
        const line = result.stderr.split("\n").find((entry) => entry.includes("still alive"))!;
        expect(line).toContain("; handle details: ");
        const details = JSON.parse(line.split("; handle details: ")[1] ?? "");
        expect(details).toContain("stdout");
        expect(details).toContain("stderr");
        expect(details).toContainEqual({ tls: "exit-probe.test", remote: "127.0.0.1" });
        expect(details).toContainEqual({ argv0: ("exit-child\n" + "x".repeat(300)).slice(0, 255) });
        expect(line).not.toContain("private-child-argument");
      }
    } else {
      expect(result.stderr, diagnostics).not.toContain("still alive");
    }
  },
);

it.skipIf(process.platform === "win32").for([600, 5_000])(
  "allows natural Gateway exit while bounding a lingering $0 ms timer after finalization",
  async (lingerMs, { expect, signal, onTestFinished }) => {
    const fixture = createFixtureLifetime();
    onTestFinished(() => fixture.cleanup());
    await fixture.run(async () => {
      const directory = fixture.createTempDir("gateway-settled-exit-");
      const receipt = path.join(directory, "closed.txt");
      const result = await fixture.track(
        runNodeScript(
          [
            "--input-type=module",
            "--eval",
            `
      import fs from "node:fs";
      import { setTimeout as delay } from "node:timers/promises";
      import { runGatewayLoop } from ${JSON.stringify(resolveRuntimeWorkerUrl(gatewayDirectStopEntrypoints.runLoop).href)};
      import { runCliWithExitFinalization } from ${JSON.stringify(resolveRuntimeWorkerUrl(cliMessageExitEntrypoints.oneShotExit).href)};
      await runCliWithExitFinalization({
        run: async () => {
          await runGatewayLoop({ ownsProcessLifecycle: true, start: async () => {
            setImmediate(() => process.kill(process.pid, "SIGTERM"));
            return {
              startupSettled: Promise.resolve(), getTailscaleIngressEndpoint: () => undefined,
              close: async () => {
                const lingering = setTimeout(() => {}, ${lingerMs});
                if (${lingerMs} > 1_000) setTimeout(() => { clearTimeout(lingering); process.exitCode = 1; }, 2_000).unref();
                console.log("completed cleanly");
              },
            };
          }});
        },
        finalize: async () => {
          await delay(250);
          fs.writeFileSync(${JSON.stringify(receipt)}, "accepted writes settled");
          console.log("finalized");
        },
        onError: error => { throw error; },
      });
    `,
          ],
          {
            PATH: process.env.PATH,
            HOME: directory,
            OPENCLAW_STATE_DIR: directory,
            OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
            OPENCLAW_NO_RESPAWN: "1",
          },
          15_000,
          { signal },
        ),
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.stdout).toContain("completed cleanly");
      expect(result.stdout).toContain("finalized");
      expect(fs.readFileSync(receipt, "utf8")).toBe("accepted writes settled");
      if (lingerMs < 1_000) {
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain("still alive");
      } else {
        expect(result.stderr).toContain("still alive after 1000ms");
        expect(result.stderr).toMatch(/active handles:.*Socketx2/u);
      }
    });
  },
);
