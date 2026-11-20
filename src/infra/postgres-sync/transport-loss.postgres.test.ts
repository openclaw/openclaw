import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData, Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import { hasSqliteWorkerOutcomeUnknown } from "../sqlite-worker-contract.js";
import { PostgresSyncConnection } from "./connection.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : "";

describe.skipIf(!connection)("PostgreSQL transport loss", () => {
  it("retires only the silent connection without replaying its uncertain commit", async () => {
    const target = new URL(connection);
    const dropped = new Int32Array(new SharedArrayBuffer(4));
    // The relay must continue forwarding writes while the synchronous caller waits.
    const relay = new Worker(
      `const net = require("node:net");
       const { parentPort, workerData } = require("node:worker_threads");
       const dropped = new Int32Array(workerData.signal);
       const server = net.createServer((caller) => {
         const pg = net.connect(workerData.target);
         caller.pipe(pg);
         pg.on("data", bytes => {
           if (!Atomics.load(dropped, 0)) caller.write(bytes);
         });
         caller.on("close", () => pg.destroy());
         pg.on("close", () => caller.destroy());
         caller.on("error", () => pg.destroy());
         pg.on("error", () => caller.destroy());
       });
       server.on("error", error => { throw error; });
       server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));`,
      {
        eval: true,
        workerData: {
          signal: dropped.buffer,
          target: target.searchParams.get("host")?.startsWith("/")
            ? { path: `${target.searchParams.get("host")}/.s.PGSQL.${target.port || 5432}` }
            : { host: target.hostname, port: Number(target.port || 5432) },
        },
      },
    );
    const anchor = new DatabaseSync(":memory:");
    const schema = "public";
    const run = withEngineStoreAdmission;
    let writer: PostgresSyncConnection | undefined;
    let peer: PostgresSyncConnection | undefined;
    try {
      const [port] = await once(relay, "message");
      target.searchParams.delete("host");
      target.hostname = "127.0.0.1";
      target.port = String(port);
      writer = run(
        () =>
          new PostgresSyncConnection(target.href, schema, anchor, schema, {
            statementTimeoutMs: 1000,
          }),
      );
      peer = run(() => new PostgresSyncConnection(connection, schema, anchor, schema));
      const db = writer;
      const healthy = peer;
      run(() => {
        const before = healthy.prepare("SELECT pg_backend_pid() AS pid").get();
        db.exec("CREATE TEMP TABLE transport_loss (id integer)");
        db.exec("BEGIN; INSERT INTO transport_loss VALUES (7)");
        Atomics.store(dropped, 0, 1);
        const started = performance.now();
        let failure: unknown;
        try {
          db.exec("COMMIT");
        } catch (error) {
          failure = error;
        }
        expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
        expect(db.isOpen).toBe(false);
        expect(() => db.exec("COMMIT")).toThrow("outcome unknown");
        expect(healthy.prepare("SELECT pg_backend_pid() AS pid").get()).toEqual(before);
        expect(performance.now() - started).toBeLessThan(20_000);
      });
    } finally {
      try {
        writer?.close();
        peer?.close();
      } finally {
        anchor.close();
        await relay.terminate();
      }
    }
  }, 150_000);
});
