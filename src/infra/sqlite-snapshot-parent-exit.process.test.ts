import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

it("allows retirement after delivery while the producer's send callback is pending", async ({
  expect,
  signal,
  onTestFinished,
}) => {
  const fixture = createFixtureLifetime();
  onTestFinished(() => fixture.cleanup());
  await fixture.run(async () => {
    const root = fixture.createTempDir("sqlite-snapshot-delivery-");
    const source = path.join(root, "source.sqlite");
    using database = new DatabaseSync(source);
    database.exec("CREATE TABLE probe(value); INSERT INTO probe VALUES(7)");
    database.close();
    const original = fs.readFileSync(source);
    const gate = path.join(root, "release");
    const preload = path.join(root, "preload.cjs");
    fs.writeFileSync(
      preload,
      `
      const fs = require("node:fs");
      if (process.argv[3] === "session") {
        const send = process.send.bind(process);
        process.send = (message, callback) => send(message, error => {
          if (!String(message.result?.location).endsWith("database.sqlite")) return callback(error);
          const deliver = () => fs.existsSync(${JSON.stringify(gate)})
            ? callback(error) : setTimeout(deliver, 10);
          deliver();
        });
      }
      `,
    );
    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { captureSqliteReadOnlyWorkerLaunch, createScopedSqliteReadOnlyWorker } from ${JSON.stringify(new URL("./sqlite-readonly-worker.ts", import.meta.url).href)};
      import { removeTempDirectory } from ${JSON.stringify(new URL("./sqlite-readonly-location-cleanup.ts", import.meta.url).href)};
      const worker = createScopedSqliteReadOnlyWorker(captureSqliteReadOnlyWorkerLaunch());
      let directory;
      try {
        const location = await worker.run(${JSON.stringify(source)}, { mode: "sync" });
        directory = path.dirname(location);
        let failure;
        const removed = removeTempDirectory(directory, error => { failure = String(error); });
        console.log(JSON.stringify({ removed, failure, retained: fs.existsSync(directory) }));
      } finally {
        fs.writeFileSync(${JSON.stringify(gate)}, "release");
        await worker.close();
        await worker.closed;
        if (directory) removeTempDirectory(directory);
      }
    `;
    const result = await fixture.track(
      runNodeScript(
        ["--import=tsx", "--input-type=module", "--eval", script],
        {
          PATH: process.env.PATH,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
          NODE_DISABLE_COMPILE_CACHE: "1",
          TSX_DISABLE_CACHE: "1",
        },
        20_000,
        { signal, maxBuffer: 1024 * 1024 },
      ),
    );
    expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
    expect(JSON.parse(result.stdout)).toEqual({ removed: true, retained: false });
    expect(fs.readFileSync(source)).toEqual(original);
  });
});

it.skipIf(process.platform === "win32").for(["retained", "staged", "session", "one-shot"] as const)(
  "retires a surviving %s copy after its creator is killed during publication",
  async (mode, { expect, signal, onTestFinished }) => {
    const fixture = createFixtureLifetime();
    onTestFinished(() => fixture.cleanup());
    await fixture.run(async () => {
      const root = fixture.createTempDir("sqlite-snapshot-parent-exit-");
      const source = path.join(root, "source.sqlite");
      using database = new DatabaseSync(source);
      database.exec("CREATE TABLE probe(value BLOB); INSERT INTO probe VALUES(zeroblob(2097152))");
      database.close();
      const original = fs.readFileSync(source);
      const entered = path.join(root, "entered");
      const gate = path.join(root, "release");
      const processes = path.join(root, "processes");
      const tokenClosed = path.join(root, "token-closed");
      const preload = path.join(root, "preload.cjs");
      fs.writeFileSync(
        preload,
        `
        const fs = require("node:fs");
        if (process.argv[2] === "--openclaw-sqlite-readonly-child") {
          fs.appendFileSync(${JSON.stringify(processes)}, process.pid + "\\n");
        }
        if (process.argv[3] === "session") {
          process.once("exit", () => fs.writeFileSync(${JSON.stringify(tokenClosed)}, "closed"));
        }
        if (["staged-sync", "session", "sync"].includes(process.argv[3])) {
          const rename = fs.renameSync;
          fs.renameSync = (from, to) => {
            if (String(to).endsWith("database.sqlite")) {
              fs.writeFileSync(${JSON.stringify(entered)}, JSON.stringify({ pid: process.pid, location: String(from) }));
              const deadline = Date.now() + 30000;
              while (!fs.existsSync(${JSON.stringify(gate)})) {
                if (Date.now() > deadline) throw new Error("copy gate timed out");
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
              }
            }
            return rename(from, to);
          };
          require("node:module").syncBuiltinESMExports();
        }
      `,
      );
      const producer =
        mode === "retained"
          ? `
        import { startSqliteReadOnlyLocationAsync } from ${JSON.stringify(new URL("./sqlite-snapshot-source.ts", import.meta.url).href)};
        await startSqliteReadOnlyLocationAsync(${JSON.stringify(source)}, { preserveSourceArtifacts: true }).result;
      `
          : `
        import { captureSqliteReadOnlyWorkerLaunch, createScopedSqliteReadOnlyWorker, runSqliteReadOnlyWorkerOnce } from ${JSON.stringify(new URL("./sqlite-readonly-worker.ts", import.meta.url).href)};
        ${
          mode === "staged"
            ? `
          const owner = createScopedSqliteReadOnlyWorker(captureSqliteReadOnlyWorkerLaunch());
          const directory = await owner.run(${JSON.stringify(root)}, { mode: "staging-create" });
          await runSqliteReadOnlyWorkerOnce(${JSON.stringify(source)}, { mode: "staged-sync", stagingRoot: directory });
        `
            : `await ${mode === "session" ? "createScopedSqliteReadOnlyWorker(captureSqliteReadOnlyWorkerLaunch()).run" : "runSqliteReadOnlyWorkerOnce"}(${JSON.stringify(source)}, { mode: "sync" });`
        }

      `;
      const supervisor = `
        import fs from "node:fs";
        import path from "node:path";
        import { spawn } from "node:child_process";
        import { setTimeout as delay } from "node:timers/promises";
        const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
        const pids = () => fs.existsSync(${JSON.stringify(processes)})
          ? fs.readFileSync(${JSON.stringify(processes)}, "utf8").trim().split("\\n").map(Number) : [];
        const host = spawn(process.execPath, ["--import=tsx", "--input-type=module", "--eval", ${JSON.stringify(producer)}], {
          env: { ...process.env, NODE_OPTIONS: "--require=" + JSON.stringify(${JSON.stringify(preload)}) },
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        host.stderr.on("data", chunk => { stderr += chunk; });
        const exited = new Promise(resolve => host.once("exit", resolve));
        try {
          const deadline = Date.now() + 20000;
          while (!fs.existsSync(${JSON.stringify(entered)})) {
            if (Date.now() > deadline || host.exitCode !== null) throw new Error("copy did not reach publication: " + stderr);
            await delay(10);
          }
          const { pid, location } = JSON.parse(fs.readFileSync(${JSON.stringify(entered)}, "utf8"));
          const copiedBytes = fs.statSync(location).size;
          host.kill("SIGKILL");
          await exited;
          const tokenDeadline = Date.now() + 10000;
          while (${JSON.stringify(["retained", "staged"].includes(mode))} && !fs.existsSync(${JSON.stringify(tokenClosed)})) {
            if (Date.now() > tokenDeadline) throw new Error("token owner did not settle disconnect");
            await delay(10);
          }
          const copyAlive = alive(pid);
          const fenced = fs.existsSync(location);
          fs.writeFileSync(${JSON.stringify(gate)}, "release");
          const cleanupDeadline = Date.now() + 10000;
          while (pids().some(alive) && Date.now() < cleanupDeadline) await delay(10);
          console.log(JSON.stringify({ copiedBytes, fenced, copyAlive, protected: fenced || !copyAlive,
            retained: fs.existsSync(path.dirname(location)), surviving: pids().filter(alive) }));
        } finally {
          fs.writeFileSync(${JSON.stringify(gate)}, "release");
          if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
          await exited;
          for (const pid of pids()) { if (alive(pid)) process.kill(pid, "SIGKILL"); }
        }
      `;
      const result = await fixture.track(
        runNodeScript(
          ["--import=tsx", "--input-type=module", "--eval", supervisor],
          {
            PATH: process.env.PATH,
            HOME: root,
            USERPROFILE: root,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            NODE_DISABLE_COMPILE_CACHE: "1",
            TSX_DISABLE_CACHE: "1",
          },
          40_000,
          { signal, maxBuffer: 1024 * 1024 },
        ),
      );
      expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
      expect(JSON.parse(result.stdout)).toMatchObject({
        copiedBytes: original.length,
        protected: true,
        ...(mode !== "retained" ? { fenced: true, copyAlive: true } : {}),
        retained: false,
        surviving: [],
      });
      expect(fs.readFileSync(source)).toEqual(original);
    });
  },
);
