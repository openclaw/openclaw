import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withEngineStoreAdmission } from "../database-engine/admission-scope.js";
import { PostgresSyncConnection } from "./connection.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;

describe.skipIf(!connection)("PostgreSQL exclusive idle connection reuse", () => {
  const admin = new Client({ connectionString: connection });
  const schema = `reuse_${randomUUID().replaceAll("-", "")}`;
  const anchor = new DatabaseSync(":memory:");
  const opened: PostgresSyncConnection[] = [];
  const run = withEngineStoreAdmission;
  function open(dsn = connection!, namespace = schema) {
    const db = run(
      () => new PostgresSyncConnection(dsn, namespace, anchor, schema, { reuse: true }),
    );
    opened.push(db);
    return db;
  }
  const pid = (db: PostgresSyncConnection) =>
    run(() => db.prepare("SELECT pg_backend_pid() AS pid").get()!.pid);

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".entries (id integer)`);
  });
  afterAll(async () => {
    for (const db of opened) {
      run(() => db.close());
    }
    anchor.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("reuses an idle backend, but overlapping transactions have exclusive connections", () => {
    const first = open();
    const firstPid = pid(first);
    run(() => first.close());
    expect(first.isOpen).toBe(false);
    expect(() => run(() => first.exec("SELECT 1"))).toThrow("closed");
    const writer = open();
    expect(pid(writer)).toBe(firstPid);
    run(() => writer.exec("BEGIN; INSERT INTO entries VALUES (1)"));
    const reader = open();
    expect(pid(reader)).not.toBe(firstPid);
    expect(run(() => reader.prepare("SELECT count(*)::int AS count FROM entries").get())).toEqual({
      count: 0,
    });
    // Closing a live transaction must roll it back and discard that backend.
    run(() => writer.close());
    expect(run(() => reader.prepare("SELECT count(*)::int AS count FROM entries").get())).toEqual({
      count: 0,
    });
    run(() => reader.close());
  });

  it("reconnects after an idle backend is terminated, without reusing the broken backend", async () => {
    const first = open();
    const killedPid = pid(first);
    run(() => first.close());
    await admin.query("SELECT pg_terminate_backend($1)", [killedPid]);
    // The server's termination notification is ordered before this next command response.
    await admin.query("SELECT 1");
    const recovered = open();
    expect(pid(recovered)).not.toBe(killedPid);
    expect(run(() => recovered.prepare("SELECT 7::int AS value").get())).toEqual({ value: 7 });
    run(() => recovered.close());
  });

  it("uses the server transaction status when a combined statement leaves a transaction open", () => {
    const first = open();
    const originalPid = pid(first);
    run(() => first.exec("SELECT 1; BEGIN; INSERT INTO entries VALUES (2)"));
    run(() => first.close());
    const second = open();
    expect(pid(second)).not.toBe(originalPid);
    expect(run(() => second.prepare("SELECT count(*)::int AS count FROM entries").get())).toEqual({
      count: 0,
    });
    run(() => second.close());
  });

  it("does not reuse across connection settings or namespaces", () => {
    const first = open();
    const originalPid = pid(first);
    run(() => first.close());
    const differentNamespace = open(connection!, "public");
    expect(pid(differentNamespace)).not.toBe(originalPid);
    expect(
      run(() => differentNamespace.prepare("SELECT current_schema() AS schema").get()),
    ).toEqual({
      schema: "public",
    });
    run(() => differentNamespace.close());
    const dsn = new URL(connection!);
    dsn.searchParams.set("application_name", "reuse-independent");
    const differentSettings = open(dsn.href);
    expect(pid(differentSettings)).not.toBe(originalPid);
    run(() => differentSettings.close());
  });
});
