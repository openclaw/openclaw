import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as kyselySync from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { isSecretValueRegisteredForRedaction as isRegistered } from "../../logging/secret-redaction-registry.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import * as stateDb from "../../state/openclaw-state-db.js";
import {
  closeOpenClawStateDatabaseAsync as closeDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../sentinel.js";
import { writeSecretStoreEntryForConfigRefInDatabase as writeConfigRef } from "./secret-store-config-ref.kernel.js";
import {
  captureSecretStoreExpiryCutoffs,
  purgeExpiredSecretStoreEntriesInDatabase,
} from "./secret-store-expiry.kernel.js";
import { listHiddenGitHubSecretRecords } from "./secret-store-hidden-github.js";
import {
  consumeGitHubSetupHandoff,
  deleteHiddenGitHubSecretRecord,
  deleteSecretStoreEntry,
  listSecretStoreEntries,
  purgeExpiredSecretStoreEntries as purgeStoredSecrets,
  readHiddenGitHubSecretRecord,
  readSecretStoreExecEnvironment as readExec,
  readSecretStoreValue,
  SECRET_STORE_VALUE_MAX_BYTES,
  type SecretStoreWriteParams,
  writeHiddenGitHubSecretRecord,
  writeSecretStoreEntry,
} from "./secret-store.js";

function purge() {
  return purgeExpiredSecretStoreEntriesInDatabase(captureSecretStoreExpiryCutoffs(), database)
    .removed;
}

const roots: string[] = [];
const team = { kind: "team" } as const;
let database: ReturnType<typeof createDatabaseOptions>;
beforeEach(() => {
  database = createDatabaseOptions();
});

function write(
  name: string,
  value: string,
  options: Partial<Pick<SecretStoreWriteParams, "kind" | "allowedHosts" | "updatedBy">> = {},
) {
  return writeSecretStoreEntry({
    scope: team,
    name,
    value,
    kind: "secret",
    updatedBy: "test",
    database,
    ...options,
  });
}

function read(name: string) {
  return readSecretStoreValue({ scope: team, name, database });
}
function list(includeDeleted = false) {
  return listSecretStoreEntries({ scope: team, includeDeleted, database });
}
function remove(name: string) {
  return deleteSecretStoreEntry({ scope: team, name, database });
}
function readHidden(name: string) {
  return readHiddenGitHubSecretRecord({ name });
}
function removeHidden(name: string) {
  return deleteHiddenGitHubSecretRecord({ name });
}
function writeHidden(name: string, value: string) {
  return writeHiddenGitHubSecretRecord({ name, value });
}

function githubName(kind: string, digit = "3") {
  return `github-${kind}-${digit.repeat(32)}`;
}

function notFound(code = "SECRET_STORE_NOT_FOUND") {
  return { ok: false, error: expect.objectContaining({ code }) };
}

function invalidName() {
  return expect.objectContaining({ code: "SECRET_STORE_INVALID_NAME" });
}

function invalidWrite(
  name: string,
  code: string | undefined,
  options: Partial<Pick<SecretStoreWriteParams, "kind" | "value" | "allowedHosts">> = {},
) {
  return {
    name,
    value: "value",
    kind: "secret" as const,
    ...options,
    code: code === undefined ? undefined : `SECRET_STORE_${code}`,
  };
}

function invalidGitHubNames(prefix: string) {
  return [
    `${prefix}-${"A".repeat(32)}`,
    `${prefix}-${"a".repeat(31)}`,
    `${prefix}-${"a".repeat(33)}`,
    `${prefix}-${"a".repeat(32)}\n`,
    `${prefix}-${"a".repeat(32)}\0`,
    `${prefix}.`,
    `${prefix.toUpperCase()}-${"a".repeat(32)}`,
    `${prefix}-é${"a".repeat(31)}`,
  ];
}

function rawWriter(now: number) {
  const insert = openOpenClawStateDatabase(database).db.prepare(`
    INSERT INTO secret_store_entries
      (scope_kind, scope_id, name, kind, value, allowed_hosts,
       created_at_ms, updated_at_ms, deleted_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return (entry: {
    name: string;
    value: string;
    scopeKind?: string;
    scopeId?: string;
    kind?: string;
    allowedHosts?: string;
    created?: number;
    updated?: number;
    deleted?: number;
  }) =>
    insert.run(
      entry.scopeKind ?? "team",
      entry.scopeId ?? "",
      entry.name,
      entry.kind ?? "secret",
      entry.value,
      entry.allowedHosts ?? null,
      entry.created ?? now,
      entry.updated ?? now,
      entry.deleted ?? null,
    );
}

function createDatabaseOptions() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secret-store-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, "state"));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  return { path: path.join(root, "state", "openclaw.sqlite") };
}

function countStoredRows(name: string): number {
  const row = openOpenClawStateDatabase(database)
    .db.prepare("SELECT COUNT(*) AS count FROM secret_store_entries WHERE name = ?")
    .get(name) as { count: number };
  return row.count;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await closeDatabase();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("secret store", () => {
  it("discovers newly deleted entries after idle and purges overdue entries after restart", async () => {
    vi.useFakeTimers();
    const deletedAtMs = Date.UTC(2026, 0, 1);
    vi.setSystemTime(deletedAtMs);
    await expect(purgeStoredSecrets({ database })).resolves.toBe(0);

    await write("EXPIRED_AFTER_IDLE", "retired");
    await remove("EXPIRED_AFTER_IDLE");
    await expect(purgeStoredSecrets({ database })).resolves.toBe(0);

    vi.setSystemTime(deletedAtMs + 30 * 24 * 60 * 60_000);
    await expect(purgeStoredSecrets({ database })).resolves.toBe(0);
    expect(countStoredRows("EXPIRED_AFTER_IDLE")).toBe(1);

    vi.setSystemTime(deletedAtMs + 30 * 24 * 60 * 60_000 + 1);
    await closeDatabase();
    await expect(purgeStoredSecrets({ database })).resolves.toBe(1);
    expect(countStoredRows("EXPIRED_AFTER_IDLE")).toBe(0);
  });

  it("retains a transient handoff refreshed before the purge acquires its writer", async () => {
    vi.useFakeTimers();
    const createdAtMs = Date.UTC(2026, 0, 1);
    vi.setSystemTime(createdAtMs);
    const name = githubName("setup", "5");
    await write(name, "handoff");
    vi.setSystemTime(createdAtMs + 10 * 60_000 + 1);
    const runTransaction = stateDb.runOpenClawStateWriteTransaction;
    const acquire = vi
      .spyOn(stateDb, "runOpenClawStateWriteTransaction")
      .mockImplementationOnce((operation, options, transactionOptions) => {
        openOpenClawStateDatabase(database)
          .db.prepare("UPDATE secret_store_entries SET created_at_ms = ? WHERE name = ?")
          .run(Date.now(), name);
        return runTransaction(operation, options, transactionOptions);
      });
    try {
      expect(purge()).toBe(0);
      expect(countStoredRows(name)).toBe(1);
    } finally {
      acquire.mockRestore();
    }
  });

  it.each([
    { kind: "secret", allowedHosts: [], ageMs: 0, accepted: true },
    { kind: "env", allowedHosts: undefined, ageMs: 0, accepted: false },
    { kind: "secret", allowedHosts: ["github.com"], ageMs: 0, accepted: false },
    { kind: "secret", allowedHosts: undefined, ageMs: 10 * 60_000 + 1, accepted: false },
  ] as const)(
    "consumes only a fresh, unbound handoff %#",
    async ({ kind, allowedHosts, ageMs, accepted }) => {
      const name = githubName("setup", "1");
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now - ageMs);
      await write(name, "temporary-value", { kind, allowedHosts });
      vi.setSystemTime(now);
      const consumption = consumeGitHubSetupHandoff({ name });
      const duplicate = accepted ? consumeGitHubSetupHandoff({ name }) : undefined;
      expect(await consumption).toBe(accepted ? "temporary-value" : undefined);
      if (accepted) {
        expect(await duplicate).toBeUndefined();
        expect(countStoredRows(name)).toBe(0);
        await write("DEPLOY_TOKEN", "unrelated-value");
        expect(await consumeGitHubSetupHandoff({ name: "DEPLOY_TOKEN" })).toBeUndefined();
        expect(await read("DEPLOY_TOKEN")).toEqual({ ok: true, value: "unrelated-value" });
      }
    },
  );

  it("never hands a chat key to a stale reference whose entry was removed and purged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const baseName = "GATEWAY_REMOTE_TOKEN";
    await write(baseName, "retired", {
      allowedHosts: ["api.example.com"],
      updatedBy: "cli",
    });
    await remove(baseName);
    vi.setSystemTime(new Date("2026-02-01T00:00:00.001Z"));
    expect(purge()).toBe(1);

    const save = (value: string) =>
      writeConfigRef({ baseName, value, writer: "openclaw", now: 1 }, database);
    const saved = save("from-chat");
    const rotated = save("rotated");
    expect(rotated.name).not.toBe(saved.name);
    expect(saved.name).toMatch(/^GATEWAY_REMOTE_TOKEN_[0-9A-F]{16}$/);

    expect(await read(baseName)).toEqual(notFound());
    expect(await read(saved.name)).toEqual({ ok: true, value: "from-chat" });
  });

  it("writes nothing when the requester loses authority before commit", async () => {
    expect(() =>
      writeConfigRef(
        { baseName: "GATEWAY_REMOTE_TOKEN", value: "from-chat", writer: "openclaw:1", now: 1 },
        database,
        (stage) => {
          if (stage === "commit") {
            throw new Error("requesting run is no longer active");
          }
        },
      ),
    ).toThrow("no longer active");

    expect(await list(true)).toEqual([]);
  });

  it("round-trips env and secrets without disclosing them in listings or exec, even with masking off", async () => {
    vi.stubEnv("OPENCLAW_SECRET_SENTINELS", "off");
    await write("SERVICE_URL", "https://service.test", { kind: "env" });
    await write("SERVICE_API_KEY", "stored-super-secret", {
      allowedHosts: ["API.EXAMPLE.COM", "bücher.example"],
    });

    const entries = await list();
    const allowedHosts = ["api.example.com", "xn--bcher-kva.example"];
    expect(entries).toEqual([
      expect.objectContaining({
        name: "SERVICE_API_KEY",
        kind: "secret",
        allowedHosts,
      }),
      expect.objectContaining({
        name: "SERVICE_URL",
        kind: "env",
        valuePreview: "https://service.test",
      }),
    ]);
    expect(entries[0]).not.toHaveProperty("valuePreview");
    expect(await read("SERVICE_API_KEY")).toEqual({ ok: true, value: "stored-super-secret" });
    expect(isRegistered("stored-super-secret")).toBe(true);
    const environment = await readExec({ includeSecretSentinels: true, database });
    const sentinel = environment.secretSentinels?.SERVICE_API_KEY ?? "";
    expect(looksLikeSecretSentinel(sentinel)).toBe(true);
    expect(resolveSecretSentinel(sentinel)).toBe("stored-super-secret");
    expect(JSON.stringify(environment)).not.toContain("stored-super-secret");
    expect(environment.secretEgressBindings).toEqual([
      { name: "SERVICE_API_KEY", sentinel, allowedHosts },
    ]);
    expect(await readExec({ includeSecretSentinels: false, database })).toEqual({
      env: { SERVICE_URL: "https://service.test" },
    });
    expect(
      await readExec({ includeSecretSentinels: true, excludeNames: ["SERVICE_API_KEY"], database }),
    ).not.toHaveProperty("secretSentinels");
  });

  it.each([
    { name: "DELETE_TOKEN", retained: 1 },
    { name: githubName("setup", "4"), retained: 0 },
  ])("deletes $name idempotently under its retention policy", async ({ name, retained }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await write(name, "delete-me", { updatedBy: null });
    await remove(name);
    await remove(name);
    expect(countStoredRows(name)).toBe(retained);
    expect(await list()).toEqual([]);
    expect(await list(true)).toHaveLength(retained);
    expect(purge()).toBe(0);

    vi.setSystemTime(new Date("2026-02-01T00:00:00.001Z"));
    expect(purge()).toBe(retained);
    expect(await list(true)).toEqual([]);
  });

  it("keeps every hidden GitHub record out of listings, reads, and exec projection", async () => {
    const setupName = githubName("setup");
    const deviceName = githubName("device");
    const oauthName = githubName("oauth");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await write(setupName, "abandoned-value", { allowedHosts: [] });
    await writeHidden(deviceName, "device-value");
    await writeHidden(oauthName, "oauth-value");
    await write("UNRELATED_SECRET", "keep-value");

    expect(await listHiddenGitHubSecretRecords({ prefix: "github-device" })).toEqual([
      { name: deviceName, value: "device-value" },
    ]);
    expect(await listHiddenGitHubSecretRecords({ prefix: "github-oauth" })).toEqual([
      { name: oauthName, value: "oauth-value" },
    ]);
    expect(await readHidden(deviceName)).toBe("device-value");
    expect(await readHidden(oauthName)).toBe("oauth-value");
    expect(isRegistered("device-value")).toBe(true);
    expect(isRegistered("oauth-value")).toBe(true);
    expect((await list()).map((entry) => entry.name)).toEqual(["UNRELATED_SECRET"]);
    expect((await list(true)).map((entry) => entry.name)).toEqual(["UNRELATED_SECRET"]);
    const execEnvironment = await readExec({ includeSecretSentinels: true, database });
    for (const name of [setupName, deviceName, oauthName]) {
      expect(execEnvironment.secretSentinels ?? {}).not.toHaveProperty(name);
      expect(execEnvironment.env ?? {}).not.toHaveProperty(name);
      expect(await read(name)).toEqual(notFound("SECRET_STORE_INVALID_NAME"));
    }
  });

  it.each(["github-device", "github-oauth", undefined] as const)(
    "lists exact live %s records without materializing unrelated credentials",
    async (prefix) => {
      const now = Date.parse("2026-01-01T00:00:00.000Z");
      const insert = rawWriter(now);
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const selected = prefix ?? "github-device";
      const cases = [
        { accept: true },
        { created: now - 15 * 60_000 + 1, accept: true },
        { created: now - 15 * 60_000, accept: prefix === "github-oauth" },
        { created: now + 1, accept: false },
        { updated: now + 1, accept: true },
        { scopeKind: "identity", scopeId: "other", accept: false },
        { kind: "env", accept: false },
        { allowedHosts: "[]", accept: false },
        { deleted: now, accept: false },
        ...invalidGitHubNames(selected).map((name) => ({ name, accept: false })),
      ];
      const fixtures = cases.map((entry, index) =>
        Object.assign(
          {
            name: `${selected}-${index.toString(16).padStart(32, "0")}`,
            value: `synthetic-parity:${prefix}:${index}`,
          },
          entry,
        ),
      );
      for (const entry of fixtures.toReversed()) {
        insert(entry);
      }
      const sibling = selected === "github-device" ? "github-oauth" : "github-device";
      insert({ name: `${sibling}-${"a".repeat(32)}`, value: `synthetic-sibling:${prefix}` });
      for (let index = 0; index < 64; index++) {
        insert({ name: `UNRELATED_${index}`, value: `synthetic-unrelated:${prefix}:${index}` });
      }
      const expected = fixtures.filter((entry) => entry.accept).map((entry) => entry.name);
      if (prefix === undefined) {
        expected.push(`${sibling}-${"a".repeat(32)}`);
      }
      expect((await listHiddenGitHubSecretRecords({ prefix })).map(({ name }) => name)).toEqual(
        expected.toSorted(),
      );
      const boundary = expectDefined(fixtures[2], "expiry boundary fixture");
      expect(await readHidden(boundary.name)).toBe(
        prefix === "github-oauth" ? boundary.value : undefined,
      );
      for (const entry of fixtures) {
        expect(isRegistered(entry.value)).toBe(entry.accept);
      }
      expect(isRegistered(`synthetic-sibling:${prefix}`)).toBe(prefix === undefined);
      expect(isRegistered(`synthetic-unrelated:${prefix}:0`)).toBe(false);
    },
  );

  it.each(["UTF-8", "UTF-16le", "UTF-16be"])(
    "does not materialize unrelated expiry metadata with %s storage",
    (encoding) => {
      const { DatabaseSync } = requireNodeSqlite();
      const initial = new DatabaseSync(database.path);
      // Encoding must be fixed before the canonical schema is created.
      initial.exec(
        `PRAGMA encoding = '${encoding}'; CREATE TABLE fixture_encoding (value TEXT); DROP TABLE fixture_encoding;`,
      );
      initial.close();
      const { db } = openOpenClawStateDatabase(database);
      expect(db.prepare("PRAGMA encoding").get()).toEqual({ encoding });
      const now = Date.parse("2026-02-01T00:00:00.000Z");
      const minute = 60_000;
      const retention = 30 * 24 * 60 * minute;
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const insert = rawWriter(now);
      type Fixture = Parameters<typeof insert>[0] & {
        expired: boolean;
        scopeKind?: "team" | "identity";
        kind?: "secret" | "env";
      };
      const fixtures: Fixture[] = [];
      const add = (name: string, age: number, expired = false, overrides: Partial<Fixture> = {}) =>
        fixtures.push({
          name,
          value: `synthetic-expiry:${name}`,
          created: now - age,
          updated: now - age,
          expired,
          ...overrides,
        });
      for (const prefix of ["github-setup", "github-device"]) {
        const deadline = (prefix === "github-setup" ? 10 : 15) * minute;
        const name = (digit: string) => `${prefix}-${digit.repeat(32)}`;
        add(name("0"), deadline - 1);
        add(name("1"), deadline, prefix === "github-device");
        add(name("2"), deadline + 1, true);
        add(name("f"), deadline + 1, true, {
          scopeKind: "identity",
          scopeId: "fixture-identity",
          kind: "env",
        });
        for (const invalid of invalidGitHubNames(prefix)) {
          add(invalid, 60 * minute);
        }
      }
      const unrelatedNames = [
        ...Array.from({ length: 64 }, (_, index) => `UNRELATED_${index}`),
        `github-oauth-${"a".repeat(32)}`,
        "github-connection",
      ];
      unrelatedNames.forEach((name, index) =>
        add(name, 60 * minute, false, {
          kind: index % 2 ? "env" : "secret",
          scopeKind: index % 2 ? "identity" : "team",
          scopeId: index % 2 ? "fixture-identity" : "",
        }),
      );
      add("DELETED_AT_BOUNDARY", retention + 1, false, { deleted: now - retention });
      add("DELETED_BEFORE_BOUNDARY", retention + 1, true, { deleted: now - retention - 1 });
      for (const fixture of fixtures) {
        insert(fixture);
      }
      const readRows = () => db.prepare("SELECT * FROM secret_store_entries ORDER BY name").all();
      const before = readRows();
      const expiredNames = new Set(fixtures.filter((f) => f.expired).map((f) => f.name));
      const execute = vi.spyOn(kyselySync, "executeSqliteQuerySync");
      try {
        expect(purge()).toBe(expiredNames.size);
        expect(readRows()).toEqual(before.filter((row) => !expiredNames.has(String(row.name))));
        const materialized = execute.mock.results.flatMap((result) =>
          result.type === "return" && isRecord(result.value) && Array.isArray(result.value.rows)
            ? result.value.rows.flatMap((row) =>
                isRecord(row) && typeof row.name === "string" ? [row.name] : [],
              )
            : [],
        );
        expect(materialized).toEqual(
          expect.arrayContaining([
            `github-setup-${"1".repeat(32)}`,
            `github-device-${"1".repeat(32)}`,
            `github-setup-${"f".repeat(32)}`,
            `github-device-${"f".repeat(32)}`,
          ]),
        );
        expect(materialized.filter((name) => unrelatedNames.includes(name))).toEqual([]);
      } finally {
        execute.mockRestore();
      }
    },
  );

  it("validates and hard-deletes exact hidden GitHub device and OAuth records", async () => {
    const deviceName = githubName("device", "6");
    const oauthName = githubName("oauth", "6");
    await writeHidden(deviceName, "device-value");
    await writeHidden(oauthName, "oauth-value");

    await expect(write(oauthName, "oauth-value", { updatedBy: null })).rejects.toThrow(
      invalidName(),
    );
    await expect(remove(oauthName)).rejects.toThrow(invalidName());
    await expect(writeHidden(githubName("device", "A"), "wrong-case")).rejects.toThrow(
      invalidName(),
    );
    await expect(writeHidden(githubName("setup", "6"), "wrong-owner")).rejects.toThrow(
      invalidName(),
    );

    await removeHidden(deviceName);
    await removeHidden(deviceName);
    await removeHidden(oauthName);
    expect(countStoredRows(deviceName)).toBe(0);
    expect(countStoredRows(oauthName)).toBe(0);
    expect(await readHidden(deviceName)).toBe(undefined);
  });

  it.each([
    invalidWrite("lowercase", "INVALID_NAME", { kind: "env" }),
    invalidWrite("github-setup-token", "INVALID_NAME"),
    invalidWrite("LARGE_SECRET", "VALUE_TOO_LARGE", {
      value: "é".repeat(SECRET_STORE_VALUE_MAX_BYTES / 2 + 1),
    }),
    ...["*.example.com", "https://api.example.com", "api.example.com:443", "bad host"].map((host) =>
      invalidWrite("HOST_BOUND_SECRET", "INVALID_ALLOWED_HOST", { allowedHosts: [host] }),
    ),
    invalidWrite("EMPTY_SECRET", "VALUE_EMPTY", { value: "" }),
    invalidWrite("EMPTY_ENV", undefined, { value: "", kind: "env" }),
  ])("validates $name before storing it %#", async ({ name, value, code, ...options }) => {
    const writing = write(name, value, { ...options, updatedBy: null });
    if (code) {
      await expect(writing).rejects.toThrow(expect.objectContaining({ code }));
    } else {
      await writing;
      const stored = await read(name);
      expect(stored.ok && stored.value).toBe("");
    }
  });

  it("treats a missing lazy table as empty and preserves the current schema version", async () => {
    openOpenClawStateDatabase(database);
    await closeDatabase();
    const { DatabaseSync } = requireNodeSqlite();
    const before = new DatabaseSync(database.path);
    expect(before.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    before.exec("DROP TABLE secret_store_entries;");
    before.close();
    revokeSqliteDatabaseAdmissionsForPath(database.path);

    expect(await list()).toEqual([]);
    expect(await read("MISSING_SECRET")).toEqual(notFound());
    const stillMissing = new DatabaseSync(database.path, { readOnly: true });
    expect(
      stillMissing
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("secret_store_entries"),
    ).toBeUndefined();
    stillMissing.close();

    await write("CREATED_SECRET", "created-after-lazy-ensure", { updatedBy: null });
    expect(() =>
      openOpenClawStateDatabase(database)
        .db.prepare(
          "INSERT INTO secret_store_entries (scope_kind, scope_id, name, value, kind, created_at_ms, updated_at_ms) VALUES ('team', '', 'CREATED_SECRET', 'duplicate', 'secret', 1, 1)",
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/u);
    await closeDatabase();
    const after = new DatabaseSync(database.path, { readOnly: true });
    expect(after.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(
      after
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get("secret_store_entries_live_idx"),
    ).toEqual({ name: "secret_store_entries_live_idx" });
    after.close();
  });
});
