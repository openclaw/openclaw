import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";
import {
  deleteOpenClawStateKvJson,
  deleteOpenClawStateKvScope,
  listOpenClawStateKvJson,
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
} from "./openclaw-state-kv.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-kv-"));
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("openclaw state kv", () => {
  it("stores JSON values by scope and key", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };

    writeOpenClawStateKvJson("scope-a", "key-1", { ok: true }, { env, now: () => 123 });
    writeOpenClawStateKvJson("scope-a", "key-2", { ok: false }, { env, now: () => 124 });
    writeOpenClawStateKvJson("scope-b", "key-1", { ignored: true }, { env, now: () => 125 });

    expect(readOpenClawStateKvJson("scope-a", "key-1", { env })).toEqual({ ok: true });
    expect(listOpenClawStateKvJson("scope-a", { env })).toEqual([
      { scope: "scope-a", key: "key-1", value: { ok: true }, updatedAt: 123 },
      { scope: "scope-a", key: "key-2", value: { ok: false }, updatedAt: 124 },
    ]);
  });

  it("deletes scoped values", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    writeOpenClawStateKvJson("scope-a", "key-1", { ok: true }, { env });

    expect(deleteOpenClawStateKvJson("scope-a", "key-1", { env })).toBe(true);
    expect(readOpenClawStateKvJson("scope-a", "key-1", { env })).toBeUndefined();
    expect(deleteOpenClawStateKvJson("scope-a", "key-1", { env })).toBe(false);
  });

  it("deletes all values for a scope", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    writeOpenClawStateKvJson("scope-a", "key-1", { ok: true }, { env });
    writeOpenClawStateKvJson("scope-a", "key-2", { ok: false }, { env });
    writeOpenClawStateKvJson("scope-b", "key-1", { ignored: true }, { env });

    expect(deleteOpenClawStateKvScope("scope-a", { env })).toBe(2);
    expect(listOpenClawStateKvJson("scope-a", { env })).toEqual([]);
    expect(listOpenClawStateKvJson("scope-b", { env })).toHaveLength(1);
  });
});
