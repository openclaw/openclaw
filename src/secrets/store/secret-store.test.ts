import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
function writeHidden(name: string, value: string, updatedBy?: string | null) {
  return writeHiddenGitHubSecretRecord({ name, value, updatedBy, database });
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
    const name = "github-setup-55555555555555555555555555555555";
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
      const name = "github-setup-11111111111111111111111111111111";
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
    await write("GATEWAY_REMOTE_TOKEN", "retired", {
      allowedHosts: ["api.example.com"],
      updatedBy: "cli",
    });
    await remove("GATEWAY_REMOTE_TOKEN");
    vi.setSystemTime(new Date("2026-02-01T00:00:00.001Z"));
    expect(purge()).toBe(1);

    const saved = writeConfigRef(
      { baseName: "GATEWAY_REMOTE_TOKEN", value: "from-chat", writer: "openclaw", now: 1 },
      database,
    );

    const rotated = writeConfigRef(
      { baseName: "GATEWAY_REMOTE_TOKEN", value: "rotated", writer: "openclaw", now: 1 },
      database,
    );
    expect(rotated.name).not.toBe(saved.name);
    expect(saved.name).toMatch(/^GATEWAY_REMOTE_TOKEN_[0-9A-F]{16}$/);

    // A config key still holding the old name keeps resolving to nothing.
    expect(await read("GATEWAY_REMOTE_TOKEN")).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "SECRET_STORE_NOT_FOUND" }),
    });
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

    expect(await list()).toEqual([
      expect.objectContaining({
        name: "SERVICE_API_KEY",
        kind: "secret",
        allowedHosts: ["api.example.com", "xn--bcher-kva.example"],
      }),
      expect.objectContaining({
        name: "SERVICE_URL",
        kind: "env",
        valuePreview: "https://service.test",
      }),
    ]);
    expect((await list())[0]).not.toHaveProperty("valuePreview");
    expect(await read("SERVICE_API_KEY")).toEqual({ ok: true, value: "stored-super-secret" });
    expect(isRegistered("stored-super-secret")).toBe(true);
    const environment = await readExec({ includeSecretSentinels: true, database });
    const sentinel = environment.secretSentinels?.SERVICE_API_KEY ?? "";
    expect(looksLikeSecretSentinel(sentinel)).toBe(true);
    expect(resolveSecretSentinel(sentinel)).toBe("stored-super-secret");
    expect(JSON.stringify(environment)).not.toContain("stored-super-secret");
    expect(environment.secretEgressBindings).toEqual([
      {
        name: "SERVICE_API_KEY",
        sentinel,
        allowedHosts: ["api.example.com", "xn--bcher-kva.example"],
      },
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
    { name: "github-setup-44444444444444444444444444444444", retained: 0 },
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
    const setupName = "github-setup-33333333333333333333333333333333";
    const deviceName = "github-device-33333333333333333333333333333333";
    const oauthName = "github-oauth-33333333333333333333333333333333";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await write(setupName, "abandoned-value", { allowedHosts: [] });
    await writeHidden(deviceName, "device-value", "test");
    await writeHidden(oauthName, "oauth-value", "test");
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
      expect(await read(name)).toMatchObject({
        ok: false,
        error: { code: "SECRET_STORE_INVALID_NAME" },
      });
    }
  });

  it.each(["github-device", "github-oauth"] as const)(
    "lists exact live %s records without materializing unrelated credentials",
    async (prefix) => {
      const now = Date.parse("2026-01-01T00:00:00.000Z");
      const insert = rawWriter(now);
      vi.useFakeTimers();
      vi.setSystemTime(now);
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
        ...invalidGitHubNames(prefix).map((name) => ({ name, accept: false })),
      ];
      const fixtures = cases.map((entry, index) =>
        Object.assign(
          {
            name: `${prefix}-${index.toString(16).padStart(32, "0")}`,
            value: `synthetic-parity:${prefix}:${index}`,
          },
          entry,
        ),
      );
      for (const entry of fixtures.toReversed()) {
        insert(entry);
      }
      const sibling = prefix === "github-device" ? "github-oauth" : "github-device";
      insert({ name: `${sibling}-${"a".repeat(32)}`, value: `synthetic-sibling:${prefix}` });
      for (let index = 0; index < 64; index++) {
        insert({ name: `UNRELATED_${index}`, value: `synthetic-unrelated:${prefix}:${index}` });
      }
      expect((await listHiddenGitHubSecretRecords({ prefix })).map(({ name }) => name)).toEqual(
        fixtures
          .filter((entry) => entry.accept)
          .map((entry) => entry.name)
          .toSorted(),
      );
      for (const entry of fixtures) {
        expect(isRegistered(entry.value)).toBe(entry.accept);
      }
      expect(isRegistered(`synthetic-sibling:${prefix}`)).toBe(false);
      expect(isRegistered(`synthetic-unrelated:${prefix}:0`)).toBe(false);
    },
  );

  it("purges transient GitHub records on their own deadlines and retains OAuth state", async () => {
    const setupName = "github-setup-55555555555555555555555555555555";
    const deviceName = "github-device-55555555555555555555555555555555";
    const oauthName = "github-oauth-55555555555555555555555555555555";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await write(setupName, "setup-value", { allowedHosts: [] });
    await writeHidden(deviceName, "device-value", "test");
    await writeHidden(oauthName, "oauth-value", "test");

    vi.setSystemTime(new Date("2026-01-01T00:10:00.001Z"));
    expect(purge()).toBe(1);
    expect(countStoredRows(setupName)).toBe(0);
    expect(await readHidden(deviceName)).toBe("device-value");

    vi.setSystemTime(new Date("2026-01-01T00:15:00.000Z"));
    expect(await readHidden(deviceName)).toBe(undefined);
    expect(purge()).toBe(1);
    expect(countStoredRows(deviceName)).toBe(0);
    expect(await readHidden(oauthName)).toBe("oauth-value");

    vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));
    expect(purge()).toBe(0);
    expect(countStoredRows(oauthName)).toBe(1);
  });

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
      const fixtures: {
        name: string;
        ageMs: number;
        expired?: boolean;
        scopeKind?: "team" | "identity";
        kind?: "secret" | "env";
        deletedAgeMs?: number;
      }[] = [];
      for (const prefix of ["github-setup", "github-device"]) {
        const deadline = (prefix === "github-setup" ? 10 : 15) * minute;
        fixtures.push(
          { name: `${prefix}-${"0".repeat(32)}`, ageMs: deadline - 1 },
          {
            name: `${prefix}-${"1".repeat(32)}`,
            ageMs: deadline,
            expired: prefix === "github-device",
          },
          { name: `${prefix}-${"2".repeat(32)}`, ageMs: deadline + 1, expired: true },
          {
            name: `${prefix}-${"f".repeat(32)}`,
            ageMs: deadline + 1,
            expired: true,
            scopeKind: "identity",
            kind: "env",
          },
          ...invalidGitHubNames(prefix).map((name) => ({ name, ageMs: 60 * minute })),
        );
      }
      const unrelatedNames = [
        ...Array.from({ length: 64 }, (_, index) => `UNRELATED_${index}`),
        `github-oauth-${"a".repeat(32)}`,
        "github-connection",
      ];
      fixtures.push(
        ...unrelatedNames.map((name, index) => ({
          name,
          ageMs: 60 * minute,
          kind: index % 2 ? ("env" as const) : ("secret" as const),
          scopeKind: index % 2 ? ("identity" as const) : ("team" as const),
        })),
        { name: "DELETED_AT_BOUNDARY", ageMs: retention + 1, deletedAgeMs: retention },
        {
          name: "DELETED_BEFORE_BOUNDARY",
          ageMs: retention + 1,
          deletedAgeMs: retention + 1,
          expired: true,
        },
      );
      const insert = rawWriter(now);
      for (const fixture of fixtures) {
        insert({
          ...fixture,
          scopeId: fixture.scopeKind === "identity" ? "fixture-identity" : "",
          value: `synthetic-expiry:${fixture.name}`,
          created: now - fixture.ageMs,
          updated: now - fixture.ageMs,
          deleted: fixture.deletedAgeMs === undefined ? undefined : now - fixture.deletedAgeMs,
        });
      }
      const readRows = () => db.prepare("SELECT * FROM secret_store_entries ORDER BY name").all();
      const before = readRows();
      const expiredNames = new Set(
        fixtures.filter((fixture) => fixture.expired).map(({ name }) => name),
      );
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
    const deviceName = "github-device-66666666666666666666666666666666";
    const oauthName = "github-oauth-66666666666666666666666666666666";
    await writeHidden(deviceName, "device-value", null);
    await writeHidden(oauthName, "oauth-value", undefined);

    await expect(write(oauthName, "oauth-value", { updatedBy: null })).rejects.toThrow(
      expect.objectContaining({ code: "SECRET_STORE_INVALID_NAME" }),
    );
    await expect(remove(oauthName)).rejects.toThrow(
      expect.objectContaining({ code: "SECRET_STORE_INVALID_NAME" }),
    );
    await expect(
      writeHidden("github-device-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "wrong-case", null),
    ).rejects.toThrow(expect.objectContaining({ code: "SECRET_STORE_INVALID_NAME" }));
    await expect(
      writeHidden("github-setup-66666666666666666666666666666666", "wrong-owner", null),
    ).rejects.toThrow(expect.objectContaining({ code: "SECRET_STORE_INVALID_NAME" }));

    await removeHidden(deviceName);
    await removeHidden(deviceName);
    await removeHidden(oauthName);
    expect(countStoredRows(deviceName)).toBe(0);
    expect(countStoredRows(oauthName)).toBe(0);
    expect(await readHidden(deviceName)).toBe(undefined);
  });

  it.each([
    { name: "lowercase", value: "value", kind: "env", code: "SECRET_STORE_INVALID_NAME" },
    {
      name: "github-setup-token",
      value: "value",
      kind: "secret",
      code: "SECRET_STORE_INVALID_NAME",
    },
    {
      name: "LARGE_SECRET",
      value: "é".repeat(SECRET_STORE_VALUE_MAX_BYTES / 2 + 1),
      kind: "secret",
      code: "SECRET_STORE_VALUE_TOO_LARGE",
    },
    ...["*.example.com", "https://api.example.com", "api.example.com:443", "bad host"].map(
      (host) => ({
        name: "HOST_BOUND_SECRET",
        value: "value",
        kind: "secret" as const,
        allowedHosts: [host],
        code: "SECRET_STORE_INVALID_ALLOWED_HOST",
      }),
    ),
    { name: "EMPTY_SECRET", value: "", kind: "secret", code: "SECRET_STORE_VALUE_EMPTY" },
    { name: "EMPTY_ENV", value: "", kind: "env", code: undefined },
  ] satisfies (Pick<SecretStoreWriteParams, "name" | "value" | "kind" | "allowedHosts"> & {
    code: string | undefined;
  })[])("validates $name before storing it %#", async ({ name, value, code, ...options }) => {
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
    expect(await read("MISSING_SECRET")).toMatchObject({
      ok: false,
      error: { code: "SECRET_STORE_NOT_FOUND" },
    });
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
