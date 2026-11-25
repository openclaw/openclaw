// Covers fail-closed Doctor import of retired client device identity JSON.
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Compilable, Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readClientCredentialReceipt,
  writeClientCredentialReceipt,
} from "./client-credential-readiness.js";
import { emptyClientCredentialReceipt } from "./client-credential-receipt.js";
import type { ClientCredentialDatabase } from "./client-credential-schema.js";
import { openClientCredentialCustody } from "./client-credential-store.js";
import {
  normalizeLegacyDeviceIdentity,
  type NormalizedLegacyDeviceIdentity,
} from "./device-identity-legacy.js";
import { readStoredDeviceIdentity } from "./device-identity-store.js";
import { deriveDeviceIdFromPublicKey } from "./device-identity.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import {
  detectLegacyDeviceIdentity,
  migrateLegacyDeviceIdentity,
} from "./state-migrations.device-identity.js";
import { withGatewayLockHeld } from "./state-migrations.gateway-lock.test-support.js";

type MigrationDatabase = Pick<ClientCredentialDatabase, "device_identities">;
type MigrationOptions = Parameters<typeof migrateLegacyDeviceIdentity>[0];

const CREATED_AT_MS = 1_700_000_000_000;
const SWIFT_RAW_DEVICE_ID = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c";
const SWIFT_RAW_PUBLIC_KEY = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";
const SWIFT_RAW_PRIVATE_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // pragma: allowlist secret

describe("legacy device identity Doctor migration", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-device-identity-migration-");
    env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
  });

  function withDatabase<T>(
    operation: (database: DatabaseSync) => T,
    create = false,
  ): T | undefined {
    using owner = openClientCredentialCustody(env, {
      createIfMissing: create,
      migration: true,
    });
    if (!owner) {
      return undefined;
    }
    return runSqliteImmediateTransactionSync(owner.database, () => {
      if (create && !readClientCredentialReceipt(owner.database)) {
        writeClientCredentialReceipt(owner.database, emptyClientCredentialReceipt(), "complete");
      }
      return operation(owner.database);
    });
  }

  function query<T>(build: (db: Kysely<MigrationDatabase>) => Compilable<T>, create = false) {
    return withDatabase(
      (db) => executeSqliteQuerySync(db, build(getNodeSqliteKysely<MigrationDatabase>(db))).rows,
      create,
    );
  }

  function swiftIdentity() {
    return {
      deviceId: SWIFT_RAW_DEVICE_ID,
      publicKey: SWIFT_RAW_PUBLIC_KEY,
      privateKey: SWIFT_RAW_PRIVATE_KEY,
      createdAtMs: CREATED_AT_MS,
    };
  }

  function normalizedSwift(): NormalizedLegacyDeviceIdentity {
    const normalized = normalizeLegacyDeviceIdentity(swiftIdentity());
    if (!normalized) {
      throw new Error("expected valid Swift identity fixture");
    }
    return normalized;
  }

  function nodeIdentity() {
    return { version: 1, ...normalizedSwift() };
  }

  function anotherIdentity(): NormalizedLegacyDeviceIdentity {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const deviceId = deriveDeviceIdFromPublicKey(publicKeyPem);
    if (!deviceId) {
      throw new Error("expected generated device id");
    }
    return { deviceId, publicKeyPem, privateKeyPem, createdAtMs: CREATED_AT_MS + 1 };
  }

  function rewrapPem(pem: string): string {
    const [header, ...rest] = pem.trim().split("\n");
    const footer = rest.pop();
    if (!header || !footer) {
      throw new Error("expected PEM fixture");
    }
    const lines = rest.join("").match(/.{1,20}/g) ?? [];
    return `${header}\n${lines.join("\n")}\n${footer}\n`;
  }

  async function writeLegacy(
    params: {
      value?: unknown;
      bytes?: Buffer;
      filename?: string;
    } = {},
  ): Promise<string> {
    const sourcePath = path.join(stateDir, "identity", params.filename ?? "device.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(
      sourcePath,
      params.bytes ?? Buffer.from(`${JSON.stringify(params.value ?? nodeIdentity())}\n`, "utf8"),
    );
    return sourcePath;
  }

  function identityRow() {
    return query((db) =>
      db.selectFrom("device_identities").selectAll().where("identity_key", "=", "primary"),
    )?.[0];
  }

  function receipt(identityKey: "primary" | "node" | "shareExtension" = "primary") {
    return withDatabase(
      (db) => readClientCredentialReceipt(db)?.receipt.legacyImports[`identity:${identityKey}`],
    );
  }

  function identityFields(identity: NormalizedLegacyDeviceIdentity) {
    return {
      device_id: identity.deviceId,
      public_key_pem: identity.publicKeyPem,
      private_key_pem: identity.privateKeyPem,
      created_at_ms: identity.createdAtMs,
    };
  }
  function expectIdentity(identity = normalizedSwift()) {
    expect(identityRow()).toMatchObject(identityFields(identity));
  }

  function expectMigration(
    result: Awaited<ReturnType<typeof migrate>>,
    change = "Migrated primary device identity to SQLite.",
  ) {
    expect(result).toMatchObject({ warnings: [], changes: [change] });
  }

  function expectReplacement(result: Awaited<ReturnType<typeof migrate>>) {
    expectMigration(result, "Replaced invalid primary device identity in SQLite.");
    expect(result.notices).toEqual([
      "The repaired device has a new identity and must be approved again.",
    ]);
    expect(identityRow()?.device_id).toMatch(/^[a-f0-9]{64}$/);
  }

  function seedCanonical(identity: NormalizedLegacyDeviceIdentity): void {
    query(
      (db) =>
        db.insertInto("device_identities").values({
          identity_key: "primary",
          ...identityFields(identity),
          updated_at_ms: identity.createdAtMs + 10,
        }),
      true,
    );
  }

  function seedInvalidCanonical(): void {
    seedCanonical({
      deviceId: "0".repeat(64),
      publicKeyPem: "invalid-public-key",
      privateKeyPem: "invalid-private-key",
      createdAtMs: 1,
    });
  }

  function updateCanonical(values: Partial<ClientCredentialDatabase["device_identities"]>) {
    query((db) =>
      db.updateTable("device_identities").set(values).where("identity_key", "=", "primary"),
    );
  }

  function detect(doctorOnlyStateMigrations = true) {
    return detectLegacyDeviceIdentity({ stateDir, env, doctorOnlyStateMigrations });
  }

  function migrate(
    overrides: Partial<Pick<MigrationOptions, "detected" | "doctorOnlyStateMigrations">> = {},
  ) {
    return migrateLegacyDeviceIdentity({
      detected: detect(),
      stateDir,
      env,
      doctorOnlyStateMigrations: true,
      ...overrides,
    });
  }

  it("keeps normal migration read-only and imports only with Doctor authority", async () => {
    const sourcePath = await writeLegacy();
    expect(detect(false)).toMatchObject({ hasLegacy: false, hasInvalidCanonical: false });
    const skipped = await migrateLegacyDeviceIdentity({
      detected: detect(),
      env,
      stateDir,
    });
    expect(skipped).toEqual({ changes: [], warnings: [] });
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(identityRow()).toBeUndefined();

    const repaired = await migrate();
    expect(repaired.changes).toContain("Migrated primary device identity to SQLite.");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(identityRow()?.device_id).toBe(SWIFT_RAW_DEVICE_ID);
  });
  it("imports a Swift identity with missing metadata without touching device auth", async () => {
    const { publicKey, privateKey, deviceId } = swiftIdentity();
    const sourcePath = await writeLegacy({ value: { publicKey, privateKey, deviceId } });
    const bytes = await fsp.readFile(sourcePath);
    const authPath = path.join(stateDir, "identity", "device-auth.json");
    const authBytes = Buffer.from([0x7b, 0x0a, 0xff, 0x00, 0x7d]);
    await fsp.writeFile(authPath, authBytes);
    const startedAt = Date.now();
    const result = await migrate();
    expect(result.warnings).toEqual([]);
    expect(identityRow()).toMatchObject({
      identity_key: "primary",
      device_id: SWIFT_RAW_DEVICE_ID,
    });
    expect(identityRow()?.created_at_ms).toBeGreaterThanOrEqual(startedAt);
    expect(identityRow()?.created_at_ms).toBeLessThanOrEqual(Date.now());
    expect(fs.existsSync(sourcePath)).toBe(true);
    await expect(fsp.readFile(authPath)).resolves.toEqual(authBytes);
    expect(receipt()).toMatchObject({
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it.each([
    ["node", "node-device.json"],
    ["shareExtension", "share-device.json.native-importing"],
  ] as const)(
    "migrates the %s identity before client admission and consumes its source once",
    async (identityKey, filename) => {
      const sourcePath = await writeLegacy({ filename, value: swiftIdentity() });
      const sourceBytes = await fsp.readFile(sourcePath);
      expect(() => readStoredDeviceIdentity({ env, identityKey })).toThrow("require migration");

      const result = await migrate();

      expect(result.warnings).toEqual([]);
      const migrated = readStoredDeviceIdentity({ env, identityKey });
      expect(migrated).toEqual(normalizedSwift());
      expect(identityRow()).toBeUndefined();
      await expect(fsp.readFile(sourcePath)).resolves.toEqual(sourceBytes);
      const consumed = receipt(identityKey);
      expect(consumed).toEqual({ sha256: createHash("sha256").update(sourceBytes).digest("hex") });

      await fsp.writeFile(sourcePath, JSON.stringify({ version: 1, ...anotherIdentity() }));
      expect((await migrate()).warnings).toEqual([]);
      expect(readStoredDeviceIdentity({ env, identityKey })).toEqual(normalizedSwift());
      expect(receipt(identityKey)).toEqual(consumed);
    },
  );

  it.each(["PEM formatting", "update timestamp"])(
    "repairs %s while preserving JSON",
    async (field) => {
      const expected = normalizedSwift();
      seedCanonical(expected);
      updateCanonical(
        field === "PEM formatting"
          ? {
              public_key_pem: rewrapPem(expected.publicKeyPem),
              private_key_pem: rewrapPem(expected.privateKeyPem),
              created_at_ms: expected.createdAtMs + 50,
            }
          : { updated_at_ms: -1 },
      );
      const sourcePath = await writeLegacy();
      const result = await migrate();
      expectMigration(result);
      expectIdentity(expected);
      expect(identityRow()?.updated_at_ms).toBeGreaterThanOrEqual(expected.createdAtMs);
      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(receipt()?.sha256).toMatch(/^[a-f0-9]{64}$/);
    },
  );
  it("replaces an invalid canonical row without legacy JSON only under Doctor authority", async () => {
    seedInvalidCanonical();
    expect(detect(false).hasInvalidCanonical).toBe(false);
    const detected = detect();
    expect(detected).toMatchObject({ hasLegacy: false, hasInvalidCanonical: true });
    const skipped = await migrate({ detected, doctorOnlyStateMigrations: false });
    expect(skipped).toEqual({ changes: [], warnings: [] });
    expect(identityRow()?.device_id).toBe("0".repeat(64));
    const result = await migrate({ detected });
    expectReplacement(result);
  });

  it("repairs a corrupted local identity without reimporting consumed legacy JSON", async () => {
    const sourcePath = await writeLegacy();
    const sourceBytes = await fsp.readFile(sourcePath);
    expect((await migrate()).warnings).toEqual([]);
    const consumed = receipt();
    expect(consumed?.sha256).toMatch(/^[a-f0-9]{64}$/);
    updateCanonical({
      device_id: "0".repeat(64),
      public_key_pem: "invalid-public-key",
      private_key_pem: "invalid-private-key",
    });
    const detected = detect();
    expect(detected).toMatchObject({ hasLegacy: true, hasInvalidCanonical: true });

    const result = await migrate({ detected });

    expectReplacement(result);
    const repaired = identityRow();
    expect(repaired?.device_id).not.toBe(SWIFT_RAW_DEVICE_ID);
    expect(detect().hasInvalidCanonical).toBe(false);
    expect(receipt()).toEqual(consumed);
    await expect(fsp.readFile(sourcePath)).resolves.toEqual(sourceBytes);
  });

  it("repairs canonical identity metadata without rotating valid key material", async () => {
    const expected = normalizedSwift();
    seedCanonical(expected);
    updateCanonical({
      device_id: "0".repeat(64),
      public_key_pem: rewrapPem(expected.publicKeyPem),
      private_key_pem: rewrapPem(expected.privateKeyPem),
      created_at_ms: -1,
      updated_at_ms: -1,
    });
    const detected = detect();
    const result = await migrate({ detected });
    expectMigration(result, "Repaired invalid primary device identity metadata in SQLite.");
    expect(result.notices ?? []).toEqual([]);
    expect(identityRow()).toMatchObject({
      device_id: expected.deviceId,
      public_key_pem: expected.publicKeyPem,
      private_key_pem: expected.privateKeyPem,
      created_at_ms: expect.any(Number),
    });
  });
  it("prefers legacy key material that appears after invalid-row detection", async () => {
    seedInvalidCanonical();
    const detected = detect();
    expect(detected).toMatchObject({ hasLegacy: false, hasInvalidCanonical: true });
    const sourcePath = await writeLegacy();
    const result = await migrate({ detected });
    expectMigration(result);
    expectIdentity();
    expect(receipt()?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(sourcePath)).toBe(true);
  });
  it("reports a generated identity when the invalid row disappears before repair", async () => {
    seedInvalidCanonical();
    const detected = detect();
    query((db) => db.deleteFrom("device_identities").where("identity_key", "=", "primary"));
    const result = await migrate({ detected });
    expectReplacement(result);
  });
  it("requires mutation-time Doctor authority after canonical state becomes invalid", async () => {
    seedCanonical(normalizedSwift());
    const sourcePath = await writeLegacy();
    const detected = detect();
    expect(detected).toMatchObject({ hasLegacy: true, hasInvalidCanonical: false });
    updateCanonical({ device_id: "0".repeat(64) });
    const result = await migrate({ detected, doctorOnlyStateMigrations: false });
    expect(result).toEqual({ changes: [], warnings: [] });
    expect(identityRow()?.device_id).toBe("0".repeat(64));
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("does not generate an identity from a stale legacy-only detection", async () => {
    const sourcePath = await writeLegacy();
    const detected = detect();
    expect(detected).toMatchObject({ hasLegacy: true, hasInvalidCanonical: false });
    await fsp.unlink(sourcePath);
    const result = await migrate({ detected });
    expect(result).toEqual({ changes: [], warnings: [] });
    expect(identityRow()).toBeUndefined();
  });

  it("preserves retired identity JSON when the local receipt no longer matches shared state", async () => {
    const sourcePath = await writeLegacy();
    const original = await fsp.readFile(sourcePath);
    expect((await migrate()).warnings).toEqual([]);
    await fsp.writeFile(sourcePath, original);
    const sharedPath = path.join(stateDir, "state", "openclaw.sqlite");
    await fsp.mkdir(path.dirname(sharedPath), { recursive: true });
    {
      using restored = openNodeSqliteDatabase(sharedPath);
      restored.exec("CREATE TABLE restored_state (id INTEGER PRIMARY KEY)");
    }

    const result = await migrate();

    expect(result.warnings.join("\n")).toContain("migration is incomplete or stale");
    await expect(fsp.readFile(sourcePath)).resolves.toEqual(original);
    expect(identityRow()?.device_id).toBe(SWIFT_RAW_DEVICE_ID);
  });

  it("blocks a different canonical identity and preserves the source", async () => {
    const winner = anotherIdentity();
    seedCanonical(winner);
    const sourcePath = await writeLegacy();
    const before = await fsp.readFile(sourcePath);
    const result = await migrate();

    expect(result.warnings.join("\n")).toContain("Local client identity differs");
    expect(identityRow()?.device_id).toBe(winner.deviceId);
    await expect(fsp.readFile(sourcePath)).resolves.toEqual(before);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(receipt()).toBeUndefined();
  });

  it.each([
    ["symlink", "symlink"],
    ["hardlink", "hardlink"],
    ["oversized", Buffer.alloc(128 * 1024 + 1, 0x20)],
    ["non-UTF-8", Buffer.from([0xff, 0xfe])],
    ["invalid identity", Buffer.from(JSON.stringify({ version: 1, deviceId: "broken" }))],
  ] as const)("rejects unsafe %s source without consuming it", async (_name, source) => {
    const sourcePath = await writeLegacy({ bytes: Buffer.isBuffer(source) ? source : undefined });
    if (typeof source === "string") {
      const target = path.join(stateDir, "outside.json");
      await fsp.rename(sourcePath, target);
      await (source === "symlink" ? fsp.symlink : fsp.link)(target, sourcePath);
    }
    const result = await migrate();
    expect(result.warnings.join("\n")).toContain("Failed reading legacy device identity");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(identityRow()).toBeUndefined();
    expect(receipt()).toBeUndefined();
  });
  it("requires exclusive state ownership", async () => {
    const sourcePath = await writeLegacy();
    const result = await withGatewayLockHeld(env, 18_790, () => migrate());
    expect(result.warnings.join("\n")).toContain("OpenClaw state database is busy");
    expect(fs.existsSync(sourcePath)).toBe(true);
  });
});
