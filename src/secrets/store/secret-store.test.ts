import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as kyselySync from "../../infra/kysely-sync.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../sentinel.js";
import { writeSecretStoreEntryForConfigRefInDatabase } from "./secret-store-config-ref.kernel.js";
import {
  captureSecretStoreExpiryCutoffs,
  purgeExpiredSecretStoreEntriesInDatabase,
} from "./secret-store-expiry.kernel.js";
import {
  consumeGitHubSetupHandoff,
  deleteHiddenGitHubSecretRecord,
  deleteSecretStoreEntry,
  listHiddenGitHubSecretRecordNames,
  listSecretStoreEntries,
  readHiddenGitHubSecretRecord,
  readSecretStoreExecEnvironment,
  readSecretStoreValue,
  SECRET_STORE_VALUE_MAX_BYTES,
  type SecretStoreWriteParams,
  writeHiddenGitHubSecretRecord,
  writeSecretStoreEntry,
} from "./secret-store.js";

function purgeExpiredSecretStoreEntries(params: {
  database: ReturnType<typeof createDatabaseOptions>;
}) {
  return purgeExpiredSecretStoreEntriesInDatabase(
    captureSecretStoreExpiryCutoffs(),
    params.database,
  );
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

function createDatabaseOptions() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secret-store-")));
  roots.push(root);
  return { path: path.join(root, "state.sqlite") };
}

function countStoredRows(options: ReturnType<typeof createDatabaseOptions>, name: string): number {
  const row = openOpenClawStateDatabase(options)
    .db.prepare("SELECT COUNT(*) AS count FROM secret_store_entries WHERE name = ?")
    .get(name) as { count: number };
  return row.count;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await closeOpenClawStateDatabaseAsync();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("secret store", () => {
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
      const consumption = consumeGitHubSetupHandoff({ name, nowMs: now, database });
      const duplicate = accepted
        ? consumeGitHubSetupHandoff({ name, nowMs: now, database })
        : undefined;
      expect(await consumption).toBe(accepted ? "temporary-value" : undefined);
      if (accepted) {
        expect(await duplicate).toBeUndefined();
        expect(countStoredRows(database, name)).toBe(0);
        await write("DEPLOY_TOKEN", "unrelated-value");
        expect(await consumeGitHubSetupHandoff({ name: "DEPLOY_TOKEN", database })).toBeUndefined();
        expect(await readSecretStoreValue({ scope: team, name: "DEPLOY_TOKEN", database })).toEqual(
          { ok: true, value: "unrelated-value" },
        );
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
    await deleteSecretStoreEntry({ scope: team, name: "GATEWAY_REMOTE_TOKEN", database });
    vi.setSystemTime(new Date("2026-02-01T00:00:00.001Z"));
    expect(purgeExpiredSecretStoreEntries({ database })).toBe(1);

    const saved = writeSecretStoreEntryForConfigRefInDatabase(
      { baseName: "GATEWAY_REMOTE_TOKEN", value: "from-chat", writer: "openclaw", now: 1 },
      database,
    );

    const rotated = writeSecretStoreEntryForConfigRefInDatabase(
      { baseName: "GATEWAY_REMOTE_TOKEN", value: "rotated", writer: "openclaw", now: 1 },
      database,
    );
    expect(rotated.name).not.toBe(saved.name);
    expect(saved.name).toMatch(/^GATEWAY_REMOTE_TOKEN_[0-9A-F]{16}$/);

    // A config key still holding the old name keeps resolving to nothing.
    expect(
      await readSecretStoreValue({ scope: team, name: "GATEWAY_REMOTE_TOKEN", database }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "SECRET_STORE_NOT_FOUND" }),
    });
    expect(await readSecretStoreValue({ scope: team, name: saved.name, database })).toEqual({
      ok: true,
      value: "from-chat",
    });
  });

  it("writes nothing when the requester loses authority before commit", async () => {
    expect(() =>
      writeSecretStoreEntryForConfigRefInDatabase(
        { baseName: "GATEWAY_REMOTE_TOKEN", value: "from-chat", writer: "openclaw:1", now: 1 },
        database,
        (stage) => {
          if (stage === "commit") {
            throw new Error("requesting run is no longer active");
          }
        },
      ),
    ).toThrow("no longer active");

    expect(await listSecretStoreEntries({ scope: team, includeDeleted: true, database })).toEqual(
      [],
    );
  });

  it("round-trips env and secrets without disclosing them in listings or exec, even with masking off", async () => {
    vi.stubEnv("OPENCLAW_SECRET_SENTINELS", "off");
    await write("SERVICE_URL", "https://service.test", { kind: "env" });
    await write("SERVICE_API_KEY", "stored-super-secret", {
      allowedHosts: ["API.EXAMPLE.COM", "bücher.example"],
    });

    expect(await listSecretStoreEntries({ scope: team, database })).toEqual([
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
    expect((await listSecretStoreEntries({ scope: team, database }))[0]).not.toHaveProperty(
      "valuePreview",
    );
    expect(await readSecretStoreValue({ scope: team, name: "SERVICE_API_KEY", database })).toEqual({
      ok: true,
      value: "stored-super-secret",
    });
    expect(isSecretValueRegisteredForRedaction("stored-super-secret")).toBe(true);
    const environment = await readSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      database,
    });
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
    expect(
      await readSecretStoreExecEnvironment({ includeSecretSentinels: false, database }),
    ).toEqual({ env: { SERVICE_URL: "https://service.test" } });
    expect(
      await readSecretStoreExecEnvironment({
        includeSecretSentinels: true,
        excludeNames: ["SERVICE_API_KEY"],
        database,
      }),
    ).not.toHaveProperty("secretSentinels");
  });

  it.each([
    { name: "DELETE_TOKEN", retained: 1 },
    { name: "github-setup-44444444444444444444444444444444", retained: 0 },
  ])("deletes $name idempotently under its retention policy", async ({ name, retained }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await write(name, "delete-me", { updatedBy: null });
    await deleteSecretStoreEntry({ scope: team, name, database });
    await deleteSecretStoreEntry({ scope: team, name, database });
    expect(countStoredRows(database, name)).toBe(retained);
    expect(await listSecretStoreEntries({ scope: team, database })).toEqual([]);
    expect(
      await listSecretStoreEntries({ scope: team, includeDeleted: true, database }),
    ).toHaveLength(retained);
    expect(purgeExpiredSecretStoreEntries({ database })).toBe(0);

    vi.setSystemTime(new Date("2026-02-01T00:00:00.001Z"));
    expect(purgeExpiredSecretStoreEntries({ database })).toBe(retained);
    expect(await listSecretStoreEntries({ scope: team, includeDeleted: true, database })).toEqual(
      [],
    );
  });

  it("keeps every hidden GitHub record out of listings, reads, and exec projection", async () => {
    const setupName = "github-setup-33333333333333333333333333333333";
    const deviceName = "github-device-33333333333333333333333333333333";
    const oauthName = "github-oauth-33333333333333333333333333333333";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await write(setupName, "abandoned-value", { allowedHosts: [] });
    await writeHiddenGitHubSecretRecord({
      name: deviceName,
      value: "device-value",
      updatedBy: "test",
      database,
    });
    await writeHiddenGitHubSecretRecord({
      name: oauthName,
      value: "oauth-value",
      updatedBy: "test",
      database,
    });
    await write("UNRELATED_SECRET", "keep-value");

    expect(await listHiddenGitHubSecretRecordNames({ prefix: "github-device", database })).toEqual([
      deviceName,
    ]);
    expect(await listHiddenGitHubSecretRecordNames({ prefix: "github-oauth", database })).toEqual([
      oauthName,
    ]);
    expect(await readHiddenGitHubSecretRecord({ name: deviceName, database })).toBe("device-value");
    expect(await readHiddenGitHubSecretRecord({ name: oauthName, database })).toBe("oauth-value");
    expect(isSecretValueRegisteredForRedaction("device-value")).toBe(true);
    expect(isSecretValueRegisteredForRedaction("oauth-value")).toBe(true);
    expect(
      (await listSecretStoreEntries({ scope: team, database })).map((entry) => entry.name),
    ).toEqual(["UNRELATED_SECRET"]);
    expect(
      (await listSecretStoreEntries({ scope: team, includeDeleted: true, database })).map(
        (entry) => entry.name,
      ),
    ).toEqual(["UNRELATED_SECRET"]);
    const execEnvironment = await readSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      database,
    });
    for (const name of [setupName, deviceName, oauthName]) {
      expect(execEnvironment.secretSentinels ?? {}).not.toHaveProperty(name);
      expect(execEnvironment.env ?? {}).not.toHaveProperty(name);
      expect(await readSecretStoreValue({ scope: team, name, database })).toMatchObject({
        ok: false,
        error: { code: "SECRET_STORE_INVALID_NAME" },
      });
    }
  });

  it.each(["github-device", "github-oauth"] as const)(
    "lists exact live %s records without materializing unrelated credentials",
    async (prefix) => {
      const { db } = openOpenClawStateDatabase(database);
      const now = Date.parse("2026-01-01T00:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const insert = db.prepare(`
        INSERT INTO secret_store_entries
          (scope_kind, scope_id, name, kind, value, allowed_hosts,
           created_at_ms, updated_at_ms, deleted_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
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
        { name: `${prefix}-${"A".repeat(32)}`, accept: false },
        { name: `${prefix}-${"a".repeat(31)}`, accept: false },
        { name: `${prefix}-${"a".repeat(33)}`, accept: false },
        { name: `${prefix}-${"a".repeat(32)}\n`, accept: false },
        { name: `${prefix}-${"a".repeat(32)}\0`, accept: false },
        { name: `${prefix}.`, accept: false },
        { name: `${prefix.toUpperCase()}-${"a".repeat(32)}`, accept: false },
        { name: `${prefix}-é${"a".repeat(31)}`, accept: false },
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
      const sibling = prefix === "github-device" ? "github-oauth" : "github-device";
      insert.run(
        "team",
        "",
        `${sibling}-${"a".repeat(32)}`,
        "secret",
        `synthetic-sibling:${prefix}`,
        null,
        now,
        now,
        null,
      );
      for (let index = 0; index < 64; index++) {
        insert.run(
          "team",
          "",
          `UNRELATED_${index}`,
          "secret",
          `synthetic-unrelated:${prefix}:${index}`,
          null,
          now,
          now,
          null,
        );
      }
      expect(await listHiddenGitHubSecretRecordNames({ prefix, database })).toEqual(
        fixtures
          .filter((entry) => entry.accept)
          .map((entry) => entry.name)
          .toSorted(),
      );
      for (const entry of fixtures) {
        expect(isSecretValueRegisteredForRedaction(entry.value)).toBe(entry.accept);
      }
      expect(isSecretValueRegisteredForRedaction(`synthetic-sibling:${prefix}`)).toBe(false);
      expect(isSecretValueRegisteredForRedaction(`synthetic-unrelated:${prefix}:0`)).toBe(false);
    },
  );

  it("purges transient GitHub records on their own deadlines and retains OAuth state", async () => {
    const setupName = "github-setup-55555555555555555555555555555555";
    const deviceName = "github-device-55555555555555555555555555555555";
    const oauthName = "github-oauth-55555555555555555555555555555555";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    await write(setupName, "setup-value", { allowedHosts: [] });
    await writeHiddenGitHubSecretRecord({
      name: deviceName,
      value: "device-value",
      updatedBy: "test",
      database,
    });
    await writeHiddenGitHubSecretRecord({
      name: oauthName,
      value: "oauth-value",
      updatedBy: "test",
      database,
    });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.001Z"));
    expect(purgeExpiredSecretStoreEntries({ database })).toBe(1);
    expect(countStoredRows(database, setupName)).toBe(0);
    expect(await readHiddenGitHubSecretRecord({ name: deviceName, database })).toBe("device-value");

    vi.setSystemTime(new Date("2026-01-01T00:15:00.000Z"));
    expect(await readHiddenGitHubSecretRecord({ name: deviceName, database })).toBe(undefined);
    expect(purgeExpiredSecretStoreEntries({ database })).toBe(1);
    expect(countStoredRows(database, deviceName)).toBe(0);
    expect(await readHiddenGitHubSecretRecord({ name: oauthName, database })).toBe("oauth-value");

    vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));
    expect(purgeExpiredSecretStoreEntries({ database })).toBe(0);
    expect(countStoredRows(database, oauthName)).toBe(1);
  });

  it.each(["UTF-8", "UTF-16le", "UTF-16be"])(
    "does not materialize unrelated expiry metadata with %s storage",
    (encoding) => {
      const { DatabaseSync } = requireNodeSqlite();
      const initial = new DatabaseSync(database.path);
      // Encoding must be fixed before the canonical schema is created.
      initial.exec(`PRAGMA encoding = '${encoding}'; CREATE TABLE fixture_encoding (value TEXT);`);
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
          ...[
            `${prefix}-${"A".repeat(32)}`,
            `${prefix}-${"a".repeat(31)}`,
            `${prefix}-${"a".repeat(33)}`,
            `${prefix}-${"a".repeat(32)}\n`,
            `${prefix}-${"a".repeat(32)}\0`,
            `${prefix}-é${"a".repeat(31)}`,
            `${prefix.toUpperCase()}-${"a".repeat(32)}`,
            `${prefix}.`,
          ].map((name) => ({ name, ageMs: 60 * minute })),
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
      const insert = db.prepare(`
        INSERT INTO secret_store_entries
          (scope_kind, scope_id, name, kind, value, created_at_ms, updated_at_ms, deleted_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const fixture of fixtures) {
        insert.run(
          fixture.scopeKind ?? "team",
          fixture.scopeKind === "identity" ? "fixture-identity" : "",
          fixture.name,
          fixture.kind ?? "secret",
          `synthetic-expiry:${fixture.name}`,
          now - fixture.ageMs,
          now - fixture.ageMs,
          fixture.deletedAgeMs === undefined ? null : now - fixture.deletedAgeMs,
        );
      }
      const readRows = () => db.prepare("SELECT * FROM secret_store_entries ORDER BY name").all();
      const before = readRows();
      const expiredNames = new Set(
        fixtures.filter((fixture) => fixture.expired).map(({ name }) => name),
      );
      const execute = vi.spyOn(kyselySync, "executeSqliteQuerySync");
      try {
        expect(purgeExpiredSecretStoreEntries({ database })).toBe(expiredNames.size);
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
    await writeHiddenGitHubSecretRecord({
      name: deviceName,
      value: "device-value",
      updatedBy: null,
      database,
    });
    await writeHiddenGitHubSecretRecord({ name: oauthName, value: "oauth-value", database });

    await expect(
      write("github-oauth-66666666666666666666666666666666", "oauth-value", { updatedBy: null }),
    ).rejects.toThrow(expect.objectContaining({ code: "SECRET_STORE_INVALID_NAME" }));
    await expect(
      deleteSecretStoreEntry({
        scope: team,
        name: "github-oauth-66666666666666666666666666666666",
        database,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "SECRET_STORE_INVALID_NAME" }));
    await expect(
      writeHiddenGitHubSecretRecord({
        name: "github-device-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        value: "wrong-case",
        updatedBy: null,
        database,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "SECRET_STORE_INVALID_NAME" }));
    await expect(
      writeHiddenGitHubSecretRecord({
        name: "github-setup-66666666666666666666666666666666",
        value: "wrong-owner",
        updatedBy: null,
        database,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "SECRET_STORE_INVALID_NAME" }));

    await deleteHiddenGitHubSecretRecord({ name: deviceName, database });
    await deleteHiddenGitHubSecretRecord({ name: deviceName, database });
    await deleteHiddenGitHubSecretRecord({ name: oauthName, database });
    expect(countStoredRows(database, deviceName)).toBe(0);
    expect(countStoredRows(database, oauthName)).toBe(0);
    expect(await readHiddenGitHubSecretRecord({ name: deviceName, database })).toBe(undefined);
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
      const stored = await readSecretStoreValue({ scope: team, name, database });
      expect(stored.ok && stored.value).toBe("");
    }
  });

  it("treats a missing lazy table as empty and preserves the current schema version", async () => {
    openOpenClawStateDatabase(database);
    await closeOpenClawStateDatabaseAsync();
    const { DatabaseSync } = requireNodeSqlite();
    const before = new DatabaseSync(database.path);
    expect(before.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    before.exec("DROP TABLE secret_store_entries;");
    before.close();

    expect(await listSecretStoreEntries({ scope: team, database })).toEqual([]);
    expect(
      await readSecretStoreValue({ scope: team, name: "MISSING_SECRET", database }),
    ).toMatchObject({
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
    await closeOpenClawStateDatabaseAsync();
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
