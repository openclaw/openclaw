import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import { hasSqliteWorkerOutcomeUnknown } from "../sqlite-worker-contract.js";
import { PostgresSyncConnection } from "./connection.js";
import { usePostgresTestHarness } from "./postgres.test-support.js";

const harness = usePostgresTestHarness("blackhole");

describe.skipIf(!harness.connection)("PostgreSQL silent transport loss", () => {
  it.each(["commit", "idle"])(
    "isolates a silent %s connection without replaying writes",
    async (mode) => {
      const schema = `${harness.prefix}_${mode}`;
      const target = new URL(harness.connection!);
      const directory = harness.directories.make("pg-blackhole-");
      const signal = new SharedArrayBuffer(4);
      // The proxy must keep forwarding while the caller blocks in Atomics.wait.
      const proxy = new Worker(
        `const net = require("node:net");
       const { parentPort, workerData } = require("node:worker_threads");
       const dropped = new Int32Array(workerData.signal);
       let accepted = 0;
       const server = net.createServer((downstream) => {
         const original = accepted++ === 0;
         const upstream = net.connect(workerData.target);
         downstream.on("data", (bytes) => upstream.write(bytes));
         upstream.on("data", (bytes) => {
           if (!original || !Atomics.load(dropped, 0)) downstream.write(bytes);
         });
         downstream.on("error", () => upstream.destroy());
         upstream.on("error", () => downstream.destroy());
         downstream.on("close", () => upstream.destroy());
         upstream.on("close", () => downstream.destroy());
       });
       server.listen(workerData.path, () => parentPort.postMessage("ready"));`,
        {
          eval: true,
          workerData: {
            signal,
            path: `${directory}/.s.PGSQL.5432`,
            target: target.searchParams.get("host")?.startsWith("/")
              ? { path: `${target.searchParams.get("host")}/.s.PGSQL.${target.port || 5432}` }
              : { host: target.hostname, port: Number(target.port || 5432) },
          },
        },
      );
      const anchor = new DatabaseSync(":memory:");
      const opened: PostgresSyncConnection[] = [];
      const run = withEngineStoreAdmission;
      const open = (connection: string, statementTimeoutMs?: number) => {
        const db = run(
          () =>
            new PostgresSyncConnection(connection, schema, anchor, schema, {
              statementTimeoutMs,
            }),
        );
        opened.push(db);
        return db;
      };
      try {
        await once(proxy, "message");
        await harness.client.query(`CREATE SCHEMA "${schema}"`);
        target.hostname = "";
        target.port = "5432";
        target.searchParams.set("host", directory);
        // A small statement budget keeps real client-timeout proof bounded. The
        // lost COMMIT reply cannot be bounded by PostgreSQL's statement timeout.
        const writer = open(target.href, 1000);
        const peers = Array.from({ length: 4 }, () => open(harness.connection!));
        const peerPids = peers.map((db) =>
          run(() => db.query("SELECT pg_backend_pid() AS pid").rows),
        );
        run(() => {
          writer.exec("CREATE TABLE entries (id integer)");
          writer.exec(
            mode === "commit"
              ? "BEGIN; INSERT INTO entries VALUES (7)"
              : "INSERT INTO entries VALUES (7)",
          );
        });
        Atomics.store(new Int32Array(signal), 0, 1);
        using clock = vi.spyOn(Date, "now");
        clock.mockReturnValue(Date.now() + 60_000);
        const started = performance.now();
        let failure: unknown;
        try {
          if (mode === "commit") {
            run(() => writer.exec("COMMIT"));
          } else {
            expect(run(() => writer.query("SELECT id FROM entries").rows)).toEqual([{ id: 7 }]);
          }
        } catch (error) {
          failure = error;
        }
        if (mode === "commit") {
          expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
          expect(writer.isOpen).toBe(false);
        } else {
          expect(failure).toBeUndefined();
          expect(writer.isOpen).toBe(true);
        }
        expect(performance.now() - started).toBeLessThan(20_000);
        // Five consecutive connections cover every service, including the
        // writer's service. A silent socket must not retire healthy peers.
        expect(
          peers.map((db) => run(() => db.query("SELECT pg_backend_pid() AS pid").rows)),
        ).toEqual(peerPids);
        expect((await harness.client.query(`SELECT id FROM "${schema}".entries`)).rows).toEqual([
          { id: 7 },
        ]);
        if (mode === "commit") {
          expect(() => run(() => writer.exec("COMMIT"))).toThrow("outcome unknown");
        }
      } finally {
        for (const db of opened) {
          try {
            run(() => db.close());
          } catch {
            // Baseline service retirement can also poison a peer's close.
          }
        }
        anchor.close();
        await proxy.terminate();
      }
    },
    150_000,
  );
});
