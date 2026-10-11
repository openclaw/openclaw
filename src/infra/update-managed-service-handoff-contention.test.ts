import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "./update-managed-service-handoff-database.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.for([false, true])(
  "settles competing installation writes before pinning a reader (existing identity: %s)",
  async (existing, { signal }) => {
    const root = fs.realpathSync(dirs.make("handoff-writer-contention-"));
    const databasePath = path.join(root, "managed-update-handoffs.sqlite");
    createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
    const identity = captureManagedUpdateLeaseDatabaseIdentity(databasePath);
    const moduleUrl = pathToFileURL(
      path.resolve("src/infra/update-managed-service-handoff-database.ts"),
    ).href;
    const lockModuleUrl = pathToFileURL(path.resolve("src/infra/file-lock-sync.ts")).href;
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
      try {
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
          owner(true, db => owner.transact(db, () => insert(db), {}));
        }
        send({ phase: "committed" });
      } catch (error) {
        send({ phase: "failed", message: error.message });
        process.exitCode = 1;
      }
    `;
    const launch = (kind: string, otherPid?: number) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          path.resolve("scripts/tsx.mjs"),
          "--input-type=module",
          "--eval",
          source,
          kind,
          JSON.stringify(identity),
          String(otherPid ?? 0),
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      const closed = once(child, "close");
      void closed.catch(() => undefined);
      const lines = createInterface({ input: child.stdout });
      const ready = withinTest(
        awaitGateBeforeSettlement(once(lines, "line"), closed, "Writer exited before admission"),
        signal,
      );
      return { child, closed, ready, stderr: () => stderr };
    };
    const holder = launch("holder");
    let waiter: ReturnType<typeof launch> | undefined;
    try {
      expect(JSON.parse((await holder.ready)[0]), holder.stderr()).toEqual({ phase: "holding" });
      waiter = launch("waiter", holder.child.pid);
      const observation = JSON.parse((await waiter.ready)[0]);
      holder.child.stdin.end("x");
      const results = await withinTest(Promise.all([holder.closed, waiter.closed]), signal);
      expect(results, JSON.stringify(observation) + holder.stderr() + waiter.stderr()).toEqual([
        [0, null],
        [0, null],
      ]);
      expect(observation).toEqual({ phase: "contended" });
      const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
      try {
        expect(
          database.prepare("SELECT owner FROM managed_update_handoffs ORDER BY owner").all(),
        ).toEqual([{ owner: "holder" }, { owner: "waiter" }]);
      } finally {
        database.close();
      }
    } finally {
      for (const writer of [holder, waiter]) {
        if (!writer) {
          continue;
        }
        if (writer.child.exitCode === null && writer.child.signalCode === null) {
          writer.child.kill("SIGKILL");
        }
        await writer.closed;
      }
    }
  },
);
