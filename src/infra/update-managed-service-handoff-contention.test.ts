import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { createBoundedChildOutput } from "../../test/helpers/bounded-child-output.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import * as leases from "./update-managed-service-handoff-database.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.for(["initial", "existing", "timeout"])(
  "serializes writers or diagnoses contention (%s)",
  async (mode, { signal }) => {
    const existing = mode !== "initial";
    const root = fs.realpathSync(dirs.make("handoff-writer-contention-"));
    const databasePath = path.join(root, "managed-update-handoffs.sqlite");
    leases.createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
    const identity = leases.captureManagedUpdateLeaseDatabaseIdentity(databasePath);
    const moduleUrl = new URL("./update-managed-service-handoff-database.ts", import.meta.url).href;
    const lockModuleUrl = new URL("./file-lock-sync.ts", import.meta.url).href;
    const source = `
      import fs from "node:fs";
      import path from "node:path";
      import { once } from "node:events";
      import { DatabaseSync } from "node:sqlite";
      import { root } from "@openclaw/fs-safe/root";
      import { createManagedHandoffLeaseDatabase } from ${JSON.stringify(moduleUrl)};
      import { acquireFileLockSyncWithRetry } from ${JSON.stringify(lockModuleUrl)};
      const [kind, encoded, otherPid] = process.argv.slice(1);
      const send = value => fs.writeSync(1, JSON.stringify(value) + "\\n");
      const identity = JSON.parse(encoded);
      const lockRoot = await root(path.dirname(identity.databasePath));
      const owner = createManagedHandoffLeaseDatabase(
        identity.databasePath, ${existing ? "identity" : "undefined"}, lockRoot
      );
      const kill = process.kill;
      let observed = false;
      process.kill = (pid, signal) => {
        const result = kill(pid, signal);
        // Observe the real live-owner probe; never alter its result or release it by a timer.
        if (!observed && pid === Number(otherPid) && signal === 0) {
          observed = true;
          send({ phase: "contended" });
        }
        return result;
      };
        const insert = db => db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, '{}', 1, NULL)")
          .run(kind + "-installation", kind);
        if (kind === "holder") {
          const release = acquireFileLockSyncWithRetry(identity.databasePath, { lockRoot });
          const db = new DatabaseSync(identity.databasePath);
          try {
            db.exec("BEGIN IMMEDIATE");
            insert(db);
            const released = once(process.stdin, "data");
            send({ phase: "holding" });
            await released;
            db.exec("COMMIT");
          } finally {
            db.close();
            release();
          }
        } else {
          try { owner(true, db => owner.transact(db, () => insert(db), {})); }
          catch (error) { send({ code: error.code, phase: error.phase, holder: error.holder, message: error.message }); process.exitCode = 1; }
        }
    `;
    const runner = ["--import", path.resolve("scripts/tsx.mjs"), "--input-type=module", "--eval"];
    const launch = (kind: string, otherPid?: number) => {
      const child = spawn(
        process.execPath,
        [...runner, source, kind, JSON.stringify(identity), String(otherPid ?? 0)],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const output = createBoundedChildOutput();
      child.stdout.on("data", output.append);
      child.stderr.on("data", output.append);
      const closed = once(child, "close");
      void closed.catch(() => undefined);
      const lines = createInterface({ input: child.stdout });
      const ready = withinTest(
        awaitGateBeforeSettlement(once(lines, "line"), closed, "Writer exited before admission"),
        signal,
      );
      return {
        child,
        closed,
        ready,
        output: () => output.text(),
        async [Symbol.asyncDispose]() {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
          await closed;
        },
      };
    };
    await using holder = launch("holder");
    expect(JSON.parse((await holder.ready)[0]), holder.output()).toEqual({ phase: "holding" });
    await using waiter = launch("waiter", holder.child.pid);
    const observation = JSON.parse((await waiter.ready)[0]);
    if (mode === "timeout") {
      expect(await withinTest(waiter.closed, signal), waiter.output()).toEqual([1, null]);
      const diagnostic = JSON.parse(waiter.output().trim().split("\n").at(-1)!);
      expect(diagnostic).toMatchObject({
        code: "file_lock_timeout",
        phase: "managed-handoff:writer-admission",
        holder: { pid: holder.child.pid, alive: true },
      });
      expect(diagnostic.message).toContain(databasePath + ".lock");
      expect(diagnostic.message).toMatch(/timeout \d+ ms/);
      expect(JSON.parse(fs.readFileSync(databasePath + ".lock", "utf8")).pid).toBe(
        holder.child.pid,
      );
    }
    holder.child.stdin.end("x");
    const results = await withinTest(Promise.all([holder.closed, waiter.closed]), signal);
    expect(results, `holder: ${holder.output()}\nwaiter: ${waiter.output()}`).toEqual([
      [0, null],
      [mode === "timeout" ? 1 : 0, null],
    ]);
    expect(observation).toEqual({ phase: "contended" });
    using database = openNodeSqliteDatabase(databasePath, { readOnly: true });
    expect(
      database.prepare("SELECT owner FROM managed_update_handoffs ORDER BY owner").all(),
    ).toEqual(
      mode === "timeout" ? [{ owner: "holder" }] : [{ owner: "holder" }, { owner: "waiter" }],
    );
  },
);
