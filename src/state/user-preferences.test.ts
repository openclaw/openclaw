import { join } from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensureAgentProvenanceSchema } from "./agent-provenance.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import * as stateWorker from "./openclaw-state-worker-store.js";
import {
  getUserPreferences,
  getUserPreferenceValues,
  setCanonicalUserPreferences,
  setUserPreferences,
} from "./user-preferences.js";
import { ensureUserPreferencesSchema, mergeUserPreferences } from "./user-preferences.store.js";
import { ensureProfileForEmail } from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-user-prefs-"), "openclaw.sqlite") };
}

function openWithoutFeatureSchemas() {
  const options = stateOptions();
  const { db } = openOpenClawStateDatabase(options);
  db.exec("DROP TABLE IF EXISTS user_preferences; DROP TABLE IF EXISTS agent_provenance;");
  return { db, options };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("user preferences", () => {
  it("reads selected profile preferences in the worker and observes subsequent writes", async () => {
    const options = stateOptions();
    const first = ensureProfileForEmail("first@example.test", options).id;
    setUserPreferences(first, { push: { enabled: true }, other: "excluded" }, options);
    setUserPreferences("second", { push: false }, options);
    setUserPreferences("excluded", { push: true }, options);
    const native = vi.spyOn(openOpenClawStateDatabase(options).db, "prepare");
    const initial = await getUserPreferenceValues([first, "second", "missing"], "push", options);
    expect(initial.values).toEqual(
      new Map<string, unknown>([
        [first, { enabled: true }],
        ["second", false],
      ]),
    );
    expect(initial.isCurrent()).toBe(true);
    expect(native).not.toHaveBeenCalled();
    native.mockRestore();
    setUserPreferences(first, { push: { enabled: false } }, options);
    expect(initial.isCurrent()).toBe(false);
    const updated = await getUserPreferenceValues([first], "push", options);
    expect(updated.values).toEqual(new Map([[first, { enabled: false }]]));
    const reply = createDeferred<undefined>();
    const broker = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockReturnValueOnce(reply.promise);
    const pending = setCanonicalUserPreferences(first, { push: "worker" }, options);
    try {
      expect(updated.isCurrent()).toBe(false);
    } finally {
      reply.resolve(undefined);
      await pending;
      broker.mockRestore();
    }
    const settled = await getUserPreferenceValues([first], "push", options);
    expect(settled.values).toEqual(new Map([[first, { enabled: false }]]));
    expect(settled.isCurrent()).toBe(true);
    expect((await getUserPreferenceValues([first], "push", stateOptions())).values).toEqual(
      new Map(),
    );
    const missingTable = openWithoutFeatureSchemas();
    expect((await getUserPreferenceValues([first], "push", missingTable.options)).values).toEqual(
      new Map(),
    );
  });

  it("initializes each feature independently on each database handle", () => {
    const first = openWithoutFeatureSchemas();
    const second = openWithoutFeatureSchemas();
    ensureUserPreferencesSchema(first.options);
    expect(tableExists(first.db, "user_preferences")).toBe(true);
    expect(tableExists(first.db, "agent_provenance")).toBe(false);
    expect(tableExists(second.db, "user_preferences")).toBe(false);

    ensureAgentProvenanceSchema(first.options);
    ensureUserPreferencesSchema(second.options);
    expect(tableExists(first.db, "agent_provenance")).toBe(true);
    expect(tableExists(second.db, "user_preferences")).toBe(true);
    expect(tableExists(second.db, "agent_provenance")).toBe(false);
  });

  it("retries first-use schema creation after its transaction fails", () => {
    const { db, options } = openWithoutFeatureSchemas();
    const failure = new Error("schema write refused");
    const exec = db.exec.bind(db);
    const write = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql.includes("CREATE TABLE IF NOT EXISTS user_preferences")) {
        throw failure;
      }
      return exec(sql);
    });
    try {
      expect(() => ensureUserPreferencesSchema(options)).toThrow(failure);
      expect(db.isTransaction).toBe(false);
      expect(tableExists(db, "user_preferences")).toBe(false);
    } finally {
      write.mockRestore();
    }

    ensureUserPreferencesSchema(options);
    expect(tableExists(db, "user_preferences")).toBe(true);
  });

  it("lazily creates the additive table and isolates profile rows", () => {
    const options = stateOptions();
    const database = openOpenClawStateDatabase(options).db;
    const version = database.prepare("PRAGMA user_version").get()?.user_version;
    database.exec("DROP TABLE user_preferences;");
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase(options).db;
    expect(tableExists(reopened, "user_preferences")).toBe(false);

    expect(setUserPreferences("profile-a", { beta: 2, alpha: { enabled: true } }, options)).toEqual(
      {
        ok: true,
        value: undefined,
      },
    );
    expect(getUserPreferences("profile-a", undefined, options)).toEqual({
      alpha: { enabled: true },
      beta: 2,
    });
    expect(getUserPreferences("profile-a", ["beta"], options)).toEqual({ beta: 2 });
    expect(getUserPreferences("profile-b", undefined, options)).toEqual({});
    expect(tableExists(reopened, "user_preferences")).toBe(true);
    expect(reopened.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
  });

  it("persists a full preference batch with bounded native writes", () => {
    const options = stateOptions();
    const entries = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`key-${index}`, { enabled: index % 2 === 0 }]),
    );
    expect(setUserPreferences("profile-a", { "key-0": false }, options)).toMatchObject({
      ok: true,
    });
    expect(setUserPreferences("profile-b", { "key-0": "unrelated" }, options)).toMatchObject({
      ok: true,
    });
    // oxlint-disable-next-line typescript/unbound-method -- apply below preserves the intercepted statement receiver.
    const originalRun = StatementSync.prototype.run;
    let writes = 0;
    const run = vi.spyOn(StatementSync.prototype, "run").mockImplementation(function (
      this: StatementSync,
      ...values
    ) {
      if (/^insert into "user_preferences"/i.test(this.sourceSQL)) {
        writes++;
      }
      return originalRun.apply(this, values);
    });
    try {
      expect(setUserPreferences("profile-a", entries, options)).toEqual({
        ok: true,
        value: undefined,
      });
    } finally {
      run.mockRestore();
    }
    expect(getUserPreferences("profile-a", undefined, options)).toEqual(entries);
    expect(getUserPreferences("profile-b", undefined, options)).toEqual({ "key-0": "unrelated" });
    expect(writes).toBeGreaterThan(0);
    expect(writes).toBeLessThanOrEqual(1);
  });

  it.each(["ABORT", "FAIL"])("rolls back removals and earlier preferences on %s", (action) => {
    const options = stateOptions();
    expect(
      setUserPreferences("profile-a", { existing: "original", removed: true }, options),
    ).toMatchObject({ ok: true });
    const { db } = openOpenClawStateDatabase(options);
    const before = db.prepare("SELECT * FROM user_preferences ORDER BY profile_id, pref_key").all();
    db.exec(`CREATE TRIGGER refuse_preference BEFORE INSERT ON user_preferences
      WHEN NEW.pref_key = 'refused' BEGIN SELECT RAISE(${action}, 'preference refused'); END`);
    try {
      expect(() =>
        setUserPreferences(
          "profile-a",
          {
            removed: null,
            existing: "changed",
            inserted: true,
            refused: true,
          },
          options,
        ),
      ).toThrow("preference refused");
      expect(db.isTransaction).toBe(false);
      expect(
        db.prepare("SELECT * FROM user_preferences ORDER BY profile_id, pref_key").all(),
      ).toEqual(before);
    } finally {
      db.exec("DROP TRIGGER refuse_preference");
    }
  });

  it("rejects oversized batches and values before writing any row", () => {
    const options = stateOptions();
    const tooMany = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`key-${index}`, index]),
    );
    expect(setUserPreferences("profile-a", tooMany, options)).toMatchObject({
      ok: false,
      error: { code: "invalid-entry-count" },
    });
    expect(
      setUserPreferences("profile-a", { valid: true, oversized: "🦞".repeat(1_025) }, options),
    ).toMatchObject({ ok: false, error: { code: "value-too-large", key: "oversized" } });
    expect(getUserPreferences("profile-a", undefined, options)).toEqual({});
  });

  it("caps each profile at 128 keys while allowing deletions to free capacity", () => {
    const options = stateOptions();
    for (let start = 0; start < 127; start += 32) {
      const count = Math.min(32, 127 - start);
      const entries = Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`key-${start + index}`, true]),
      );
      expect(setUserPreferences("profile-a", entries, options)).toEqual({
        ok: true,
        value: undefined,
      });
    }

    expect(setUserPreferences("profile-a", { "key-127": true }, options)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(setUserPreferences("profile-a", { "key-128": true }, options)).toEqual({
      ok: false,
      error: { code: "profile-key-limit", limit: 128, currentCount: 128 },
    });
    expect(setUserPreferences("profile-a", { "key-0": null }, options)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(setUserPreferences("profile-a", { "key-128": true }, options)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(getUserPreferences("profile-a", ["key-0", "key-128"], options)).toEqual({
      "key-128": true,
    });
  });

  it("checks semantic expectations before any writes in a multi-entry batch", () => {
    const options = stateOptions();
    const original = { retained: { nested: { a: 1, b: 2 }, list: [1, 2] }, removed: true };
    expect(setUserPreferences("profile-a", original, options).ok).toBe(true);
    const { db } = openOpenClawStateDatabase(options);
    const before = db.prepare("SELECT * FROM user_preferences ORDER BY pref_key").all();
    db.exec(`CREATE TRIGGER reject_any_insert BEFORE INSERT ON user_preferences
      BEGIN SELECT RAISE(FAIL, 'unexpected preference insert'); END;
      CREATE TRIGGER reject_any_delete BEFORE DELETE ON user_preferences
      BEGIN SELECT RAISE(FAIL, 'unexpected preference delete'); END;`);
    try {
      expect(
        setUserPreferences(
          "profile-a",
          { removed: null, inserted: true },
          {
            ...options,
            expectedEntries: { retained: { nested: { b: 2, a: 1 }, list: [2, 1] } },
          },
        ),
      ).toEqual({ ok: false, error: { code: "conflict" } });
      expect(db.prepare("SELECT * FROM user_preferences ORDER BY pref_key").all()).toEqual(before);
    } finally {
      db.exec("DROP TRIGGER reject_any_insert; DROP TRIGGER reject_any_delete;");
    }
    expect(
      setUserPreferences(
        "profile-a",
        { removed: null, inserted: true },
        {
          ...options,
          expectedEntries: {
            retained: { list: [1, 2], nested: { b: 2, a: 1 } },
            inserted: null,
          },
        },
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(getUserPreferences("profile-a", undefined, options)).toEqual({
      retained: original.retained,
      inserted: true,
    });
    expect(
      setUserPreferences(
        "profile-a",
        {},
        {
          ...options,
          expectedEntries: { inserted: null },
        },
      ),
    ).toEqual({ ok: false, error: { code: "conflict" } });
    expect(
      setUserPreferences(
        "profile-a",
        {},
        {
          ...options,
          expectedEntries: { removed: null },
        },
      ),
    ).toEqual({ ok: true, value: undefined });
  });

  it("validates bounded expectations before changing values", () => {
    const options = stateOptions();
    const expectations = [
      {
        entries: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`key-${i}`, null])),
        code: "invalid-entry-count",
      },
      { entries: { "": true }, code: "invalid-key" },
      { entries: { invalid: undefined }, code: "invalid-value" },
      { entries: { oversized: "🦞".repeat(1_025) }, code: "value-too-large" },
    ];
    for (const { entries, code } of expectations) {
      expect(
        setUserPreferences(
          "profile-a",
          { changed: true },
          {
            ...options,
            expectedEntries: entries,
          },
        ),
      ).toMatchObject({ ok: false, error: { code } });
    }
    expect(getUserPreferences("profile-a", undefined, options)).toEqual({});
  });

  it("keeps merged profiles within the same preference cap", () => {
    const options = stateOptions();
    for (let start = 0; start < 127; start += 32) {
      const count = Math.min(32, 127 - start);
      expect(
        setUserPreferences(
          "target",
          Object.fromEntries(
            Array.from({ length: count }, (_, index) => [`target-${start + index}`, true]),
          ),
          options,
        ),
      ).toMatchObject({ ok: true });
    }
    expect(
      setUserPreferences("source", { "source-a": true, "source-b": true }, options),
    ).toMatchObject({ ok: true });

    mergeUserPreferences(openOpenClawStateDatabase(options).db, "source", "target");

    expect(Object.keys(getUserPreferences("target", undefined, options))).toHaveLength(128);
    expect(getUserPreferences("target", ["source-a", "source-b"], options)).toEqual({
      "source-a": true,
    });
    expect(getUserPreferences("source", undefined, options)).toEqual({});
  });
});
