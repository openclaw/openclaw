// Covers fail-closed Doctor import of the retired primary device identity JSON.
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  normalizeLegacyDeviceIdentity,
  type NormalizedLegacyDeviceIdentity,
} from "./device-identity-legacy.js";
import { deriveDeviceIdFromPublicKey } from "./device-identity.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  detectLegacyDeviceIdentity,
  migrateLegacyDeviceIdentity,
} from "./state-migrations.device-identity.js";

type MigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "device_auth_tokens" | "device_identities" | "migration_sources"
>;

const CREATED_AT_MS = 1_700_000_000_000;
const SWIFT_RAW_DEVICE_ID = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c";
const SWIFT_RAW_PUBLIC_KEY = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";
const SWIFT_RAW_PRIVATE_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // pragma: allowlist secret

describe("legacy device identity Doctor migration", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function useStateDir(): { env: NodeJS.ProcessEnv; stateDir: string } {
    const stateDir = tempDirs.make("openclaw-device-identity-migration-");
    return {
      env: { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir },
      stateDir,
    };
  }

  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    ({ stateDir, env } = useStateDir());
  });

  function database(fixtureEnv: NodeJS.ProcessEnv = env) {
    return openOpenClawStateDatabase({ env: fixtureEnv }).db;
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

  async function writeLegacy(params: {
    stateDir: string;
    value?: unknown;
    bytes?: Buffer;
  }): Promise<string> {
    const sourcePath = path.join(params.stateDir, "identity", "device.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(
      sourcePath,
      params.bytes ?? Buffer.from(`${JSON.stringify(params.value ?? nodeIdentity())}\n`, "utf8"),
    );
    return sourcePath;
  }

  function identityRow(fixtureEnv: NodeJS.ProcessEnv = env) {
    const db = database(fixtureEnv);
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .selectFrom("device_identities")
        .selectAll()
        .where("identity_key", "=", "primary"),
    );
  }

  function receipt(fixtureEnv: NodeJS.ProcessEnv = env) {
    const db = database(fixtureEnv);
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .selectFrom("migration_sources")
        .selectAll()
        .where("migration_kind", "=", "legacy-device-identity-json"),
    );
  }

  function seedCanonical(identity: NormalizedLegacyDeviceIdentity): void {
    const db = database();
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .insertInto("device_identities")
        .values({
          identity_key: "primary",
          device_id: identity.deviceId,
          public_key_pem: identity.publicKeyPem,
          private_key_pem: identity.privateKeyPem,
          created_at_ms: identity.createdAtMs,
          updated_at_ms: identity.createdAtMs + 10,
        }),
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

  function updateCanonical(values: Partial<OpenClawStateKyselyDatabase["device_identities"]>) {
    const db = database();
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .updateTable("device_identities")
        .set(values)
        .where("identity_key", "=", "primary"),
    );
  }

  function detect(doctorOnlyStateMigrations = true) {
    return detectLegacyDeviceIdentity({ stateDir, env, doctorOnlyStateMigrations });
  }

  function migrate(
    overrides: Partial<
      Pick<
        Parameters<typeof migrateLegacyDeviceIdentity>[0],
        "detected" | "doctorOnlyStateMigrations" | "beforeClaim" | "beforeCleanup" | "removeSource"
      >
    > = {},
    fixture = { stateDir, env },
  ) {
    return migrateLegacyDeviceIdentity({
      detected: detectLegacyDeviceIdentity({ ...fixture, doctorOnlyStateMigrations: true }),
      ...fixture,
      doctorOnlyStateMigrations: true,
      ...overrides,
    });
  }

  it("keeps normal migration read-only and imports only with Doctor authority", async () => {
    const sourcePath = await writeLegacy({ stateDir });

    const skipped = await migrateLegacyDeviceIdentity({
      detected: detect(false),
      env,
      stateDir,
    });

    expect(skipped).toEqual({ changes: [], warnings: [] });
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(identityRow()).toBeUndefined();
    closeOpenClawStateDatabaseForTest();

    const repaired = await migrate();

    expect(repaired.changes).toContain("Migrated primary device identity to SQLite.");
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(identityRow()?.device_id).toBe(SWIFT_RAW_DEVICE_ID);
  });

  it("imports a Swift identity with missing metadata without touching device auth", async () => {
    const { publicKey, privateKey, deviceId } = swiftIdentity();
    const sourcePath = await writeLegacy({ stateDir, value: { publicKey, privateKey, deviceId } });
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
    expect(fs.existsSync(sourcePath)).toBe(false);
    await expect(fsp.readFile(authPath)).resolves.toEqual(authBytes);
    expect(receipt()).toMatchObject({
      removed_source: 1,
      source_record_count: 1,
      target_table: "device_identities",
      source_sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("repairs noncanonical PEM formatting before retiring JSON", async () => {
    const expected = normalizedSwift();
    const preservedCreatedAtMs = expected.createdAtMs + 50;
    seedCanonical({
      ...expected,
      publicKeyPem: rewrapPem(expected.publicKeyPem),
      privateKeyPem: rewrapPem(expected.privateKeyPem),
      createdAtMs: preservedCreatedAtMs,
    });
    const sourcePath = await writeLegacy({ stateDir, value: nodeIdentity() });

    const result = await migrate();

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(["Migrated primary device identity to SQLite."]);
    expect(identityRow()).toMatchObject({
      device_id: expected.deviceId,
      public_key_pem: expected.publicKeyPem,
      private_key_pem: expected.privateKeyPem,
      created_at_ms: expected.createdAtMs,
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("replaces an invalid canonical row without legacy JSON only under Doctor authority", async () => {
    seedInvalidCanonical();

    expect(detect(false).hasInvalidCanonical).toBe(false);
    const detected = detect();
    expect(detected).toMatchObject({ hasLegacy: false, hasInvalidCanonical: true });

    const skipped = await migrate({ detected, doctorOnlyStateMigrations: false });
    expect(skipped).toEqual({ changes: [], warnings: [] });
    expect(identityRow()?.device_id).toBe("0".repeat(64));

    const result = await migrate({ detected });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(["Replaced invalid primary device identity in SQLite."]);
    expect(result.notices).toEqual([
      "The repaired device has a new identity and must be approved again.",
    ]);
    expect(identityRow()).toMatchObject({
      identity_key: "primary",
      device_id: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
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

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Repaired invalid primary device identity metadata in SQLite.",
    ]);
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
    const sourcePath = await writeLegacy({ stateDir, value: nodeIdentity() });

    const result = await migrate({ detected });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(["Migrated primary device identity to SQLite."]);
    const expected = normalizedSwift();
    expect(identityRow()).toMatchObject({
      device_id: expected.deviceId,
      public_key_pem: expected.publicKeyPem,
      private_key_pem: expected.privateKeyPem,
      created_at_ms: expected.createdAtMs,
    });
    expect(JSON.parse(receipt()?.report_json ?? "null")).toMatchObject({
      repairedSqliteRecordCount: 1,
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("reports a generated identity when the invalid row disappears before repair", async () => {
    seedInvalidCanonical();
    const detected = detect();
    const db = database();
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<MigrationDatabase>(db)
        .deleteFrom("device_identities")
        .where("identity_key", "=", "primary"),
    );

    const result = await migrate({ detected });

    expect(result.changes).toEqual(["Replaced invalid primary device identity in SQLite."]);
    expect(result.notices).toEqual([
      "The repaired device has a new identity and must be approved again.",
    ]);
    expect(identityRow()?.device_id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires mutation-time Doctor authority after canonical state becomes invalid", async () => {
    seedCanonical(normalizedSwift());
    const sourcePath = await writeLegacy({ stateDir, value: nodeIdentity() });
    const detected = detect();
    expect(detected).toMatchObject({ hasLegacy: true, hasInvalidCanonical: false });
    updateCanonical({ device_id: "0".repeat(64) });

    const result = await migrate({ detected, doctorOnlyStateMigrations: false });

    expect(result).toEqual({ changes: [], warnings: [] });
    expect(identityRow()?.device_id).toBe("0".repeat(64));
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("does not generate an identity from a stale legacy-only detection", async () => {
    const sourcePath = await writeLegacy({ stateDir, value: nodeIdentity() });
    const detected = detect();
    expect(detected).toMatchObject({ hasLegacy: true, hasInvalidCanonical: false });
    await fsp.unlink(sourcePath);

    const result = await migrate({ detected });

    expect(result).toEqual({ changes: [], warnings: [] });
    expect(identityRow()).toBeUndefined();
  });

  it("repairs an invalid canonical update timestamp before retiring JSON", async () => {
    const expected = normalizedSwift();
    seedCanonical(expected);
    updateCanonical({ updated_at_ms: -1 });
    const sourcePath = await writeLegacy({ stateDir, value: nodeIdentity() });

    const result = await migrate();

    expect(result.warnings).toEqual([]);
    expect(identityRow()).toMatchObject({
      device_id: expected.deviceId,
      public_key_pem: expected.publicKeyPem,
      private_key_pem: expected.privateKeyPem,
      created_at_ms: expected.createdAtMs,
    });
    expect(identityRow()?.updated_at_ms).toBeGreaterThanOrEqual(expected.createdAtMs);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(JSON.parse(receipt()?.report_json ?? "null")).toMatchObject({
      repairedSqliteRecordCount: 1,
    });
  });

  it("blocks a different canonical identity and restores the source", async () => {
    const winner = anotherIdentity();
    seedCanonical(winner);
    const sourcePath = await writeLegacy({ stateDir });
    const before = await fsp.readFile(sourcePath);

    const result = await migrate();

    expect(result.warnings.join("\n")).toContain("canonical SQLite device identity differs");
    expect(identityRow()?.device_id).toBe(winner.deviceId);
    await expect(fsp.readFile(sourcePath)).resolves.toEqual(before);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(receipt()).toBeUndefined();
  });

  it("restores a source changed before Doctor can claim it", async () => {
    const sourcePath = await writeLegacy({ stateDir });

    const result = await migrate({
      beforeClaim: (candidate) => fs.appendFileSync(candidate, " "),
    });

    expect(result.warnings.join("\n")).toContain("changed before Doctor could claim it");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(identityRow()).toBeUndefined();
    expect(receipt()).toBeUndefined();
  });

  it("preserves an interrupted native claim for native startup", async () => {
    const sourcePath = await writeLegacy({ stateDir });
    const nativeClaimPath = `${sourcePath}.native-importing`;
    await fsp.rename(sourcePath, nativeClaimPath);

    const result = await migrate();

    expect(result.warnings.join("\n")).toContain("Native device identity import is pending");
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(nativeClaimPath)).toBe(true);
    expect(identityRow()).toBeUndefined();
    expect(receipt()).toBeUndefined();
  });

  it("refuses source and interrupted claim together", async () => {
    const sourcePath = await writeLegacy({ stateDir });
    await fsp.copyFile(sourcePath, `${sourcePath}.doctor-importing`);

    const result = await migrate();

    expect(result.warnings.join("\n")).toContain("source and interrupted claim both exist");
    expect(identityRow()).toBeUndefined();
    expect(receipt()).toBeUndefined();
  });

  it("rechecks the canonical row before deleting the claimed source", async () => {
    const sourcePath = await writeLegacy({ stateDir });
    const replacement = anotherIdentity();

    const result = await migrate({
      beforeCleanup: () => {
        const db = database();
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<MigrationDatabase>(db)
            .updateTable("device_identities")
            .set({
              device_id: replacement.deviceId,
              public_key_pem: replacement.publicKeyPem,
              private_key_pem: replacement.privateKeyPem,
              created_at_ms: replacement.createdAtMs,
              updated_at_ms: replacement.createdAtMs,
            })
            .where("identity_key", "=", "primary"),
        );
      },
    });

    expect(result.warnings.join("\n")).toContain("legacy cleanup failed");
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(identityRow()?.device_id).toBe(replacement.deviceId);
    expect(receipt()).toMatchObject({ removed_source: 0 });
  });

  it("resumes an interrupted claim and cleanup receipt", async () => {
    const sourcePath = await writeLegacy({ stateDir });
    const first = await migrate({
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings.join("\n")).toContain("legacy cleanup failed");
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(receipt()).toMatchObject({ removed_source: 0 });

    closeOpenClawStateDatabaseForTest();
    const retry = await migrate();

    expect(retry.warnings).toEqual([]);
    expect(retry.changes).toEqual([
      "Removed retired device identity JSON covered by its SQLite receipt.",
    ]);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(receipt()).toMatchObject({ removed_source: 1 });
  });

  it("preserves a divergent recreated identity as a boot-safe notice while the canonical row is valid", async () => {
    const sourcePath = await writeLegacy({ stateDir });
    await migrate({
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    const divergent = anotherIdentity();
    const replacement = `${JSON.stringify({
      version: 1,
      deviceId: divergent.deviceId,
      publicKeyPem: divergent.publicKeyPem,
      privateKeyPem: divergent.privateKeyPem,
      createdAtMs: divergent.createdAtMs,
    })}\n`;
    await fsp.writeFile(sourcePath, replacement, "utf8");

    closeOpenClawStateDatabaseForTest();
    const retry = await migrate();

    // The startup readiness gate hard-fails on any migration warning, so this exact
    // classification is what keeps a divergent inert file from crash-looping the gateway.
    expect(retry.warnings).toEqual([]);
    expect(retry.notices?.join("\n")).toContain("canonical SQLite identity remains authoritative");
    await expect(fsp.readFile(sourcePath, "utf8")).resolves.toBe(replacement);
    expect(identityRow()?.created_at_ms).toBe(CREATED_AT_MS);
    expect(receipt()).toMatchObject({ removed_source: 1 });
  });

  it("does not mark a divergent preserved claim as removed", async () => {
    const sourcePath = await writeLegacy({ stateDir });
    await migrate({
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    const claimPath = `${sourcePath}.doctor-importing`;
    const replacement = `${JSON.stringify({ version: 1, ...anotherIdentity() })}\n`;
    await fsp.writeFile(claimPath, replacement, "utf8");

    closeOpenClawStateDatabaseForTest();
    const retry = await migrate();

    expect(retry.warnings).toEqual([]);
    expect(retry.notices?.join("\n")).toContain("canonical SQLite identity remains authoritative");
    await expect(fsp.readFile(claimPath, "utf8")).resolves.toBe(replacement);
    expect(receipt()).toMatchObject({ removed_source: 0 });
  });

  it("keeps the divergent-file warning fatal when the canonical row is invalid", async () => {
    const sourcePath = await writeLegacy({ stateDir });
    await migrate({
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    const replacement = `${JSON.stringify({ ...nodeIdentity(), createdAtMs: CREATED_AT_MS + 1 })}\n`;
    await fsp.writeFile(sourcePath, replacement, "utf8");
    updateCanonical({
      public_key_pem: "invalid-public-key",
      private_key_pem: "invalid-private-key",
    });

    closeOpenClawStateDatabaseForTest();
    const retry = await migrate();

    expect(retry.warnings.join("\n")).toContain("bytes differ from the migration receipt");
    expect(retry.notices ?? []).toEqual([]);
    await expect(fsp.readFile(sourcePath, "utf8")).resolves.toBe(replacement);
  });

  it("rejects symlinked, hardlinked, oversized, non-UTF-8, and invalid sources", async () => {
    const cases = await Promise.all([
      ...(["symlink", "hardlink"] as const).map(async (kind) => {
        const fixture = useStateDir();
        const target = path.join(fixture.stateDir, "outside.json");
        const sourcePath = path.join(fixture.stateDir, "identity", "device.json");
        await fsp.writeFile(target, JSON.stringify(nodeIdentity()));
        await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
        await (kind === "symlink" ? fsp.symlink : fsp.link)(target, sourcePath);
        return { env: fixture.env, stateDir: fixture.stateDir, sourcePath };
      }),
      ...[
        Buffer.alloc(128 * 1024 + 1, 0x20),
        Buffer.from([0xff, 0xfe]),
        Buffer.from(JSON.stringify({ version: 1, deviceId: "broken" })),
      ].map(async (bytes) => {
        const fixture = useStateDir();
        return {
          env: fixture.env,
          stateDir: fixture.stateDir,
          sourcePath: await writeLegacy({ stateDir: fixture.stateDir, bytes }),
        };
      }),
    ]);

    for (const testCase of cases) {
      closeOpenClawStateDatabaseForTest();
      const result = await migrate({}, testCase);
      expect(result.warnings.join("\n")).toContain("Failed reading legacy device identity");
      expect(fs.existsSync(testCase.sourcePath)).toBe(true);
      expect(identityRow(testCase.env)).toBeUndefined();
      expect(receipt(testCase.env)).toBeUndefined();
    }
  });

  it("requires exclusive state ownership", async () => {
    const sourcePath = await writeLegacy({ stateDir });
    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 10,
      port: 18_790,
      timeoutMs: 100,
    });
    if (!gatewayLock) {
      throw new Error("expected test Gateway lock");
    }
    let result: Awaited<ReturnType<typeof migrateLegacyDeviceIdentity>>;
    try {
      result = await migrate();
    } finally {
      await gatewayLock.release();
    }

    expect(result.warnings.join("\n")).toContain("OpenClaw state database is busy");
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("recovers an interrupted link pair when native fs-safe mode is off", async () => {
    configureFsSafeNative({ mode: "off" });
    try {
      const sourcePath = await writeLegacy({ stateDir });

      await fsp.link(sourcePath, `${sourcePath}.doctor-importing`);

      const result = await migrate();

      expect(result.warnings).toEqual([]);
      expect(result.changes).toEqual(["Migrated primary device identity to SQLite."]);
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
      expect(identityRow()).toMatchObject({
        identity_key: "primary",
        device_id: normalizedSwift().deviceId,
        public_key_pem: normalizedSwift().publicKeyPem,
        private_key_pem: normalizedSwift().privateKeyPem,
      });
      expect(receipt()).toMatchObject({ removed_source: 1 });
    } finally {
      configureFsSafeNative({ mode: "auto" });
    }
  });
});
