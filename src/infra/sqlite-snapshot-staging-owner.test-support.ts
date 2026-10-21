import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { createDeferredCore } from "../shared/deferred.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";

export function seedProbe(root: string, name = "source", value = "preserved", setup = "") {
  const filename = path.join(root, `${name}.sqlite`);
  using database = new (requireNodeSqlite().DatabaseSync)(filename);
  database.exec(`${setup} CREATE TABLE probe(value TEXT);`);
  database.prepare("INSERT INTO probe VALUES(?)").run(value);
  return filename;
}

export function createStagingFixture(root: string) {
  const cache = path.join(root, "cache");
  fs.mkdirSync(cache);
  return { root, cache, source: seedProbe(root) };
}

export function readProbe(filename: string) {
  using database = new (requireNodeSqlite().DatabaseSync)(filename, { readOnly: true });
  return database.prepare("SELECT value FROM probe").get();
}

export function expectProbe(filename: string) {
  expect(readProbe(filename)).toEqual({ value: "preserved" });
}

export function expectWrappedProbe(filename: string) {
  using database = openNodeSqliteDatabase(filename, { readOnly: true });
  expect(database.prepare("SELECT value FROM probe").get()).toEqual({ value: "preserved" });
}

export async function waitForGate(
  gate: { entered: ReturnType<typeof createDeferredCore<void>> },
  request: Promise<unknown>,
): Promise<void> {
  await Promise.race([
    gate.entered.promise,
    request.then(() => {
      throw new Error("Snapshot request settled before its retained release barrier");
    }),
  ]);
}
