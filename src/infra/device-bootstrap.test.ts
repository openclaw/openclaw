import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_NODE_BOOTSTRAP_TIMEOUT_MS } from "../gateway/worker-environments/bootstrap-timeouts.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { flushLogger } from "../logging/logger.js";
import {
  CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES,
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../shared/device-bootstrap-profile.js";
import { tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { overbroadBootstrapProfile } from "./device-bootstrap-profile.test-support.js";
import {
  clearDeviceBootstrapTokens,
  confirmDevicePairSetupCompletionDelivery,
  consumeDeviceBootstrapTokenWithSetupCompletion,
  getBoundDeviceBootstrapContext,
  getBoundDeviceBootstrapProfile,
  ensureDevicePairSetupBootstrapToken,
  issueDeviceBootstrapToken,
  issueDevicePairSetupBootstrapToken,
  readDevicePairSetupCompletion,
  redeemDeviceBootstrapTokenProfile,
  revokeDeviceBootstrapToken,
  verifyDeviceBootstrapToken,
} from "./device-bootstrap.js";
import { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } from "./device-identity.js";
import {
  loadDeviceBootstrapTokenRecords,
  persistDeviceBootstrapTokenRecords,
} from "./device-pairing-store.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-device-bootstrap-test-");

const openDatabase = (baseDir: string) =>
  openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } });
const issueSetupToken = (baseDir: string, profile = NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE) =>
  issueDevicePairSetupBootstrapToken({ baseDir, profile });
const boundIdentity = (baseDir: string, token: string) => ({
  baseDir,
  token,
  deviceId: "device-123",
  publicKey: "public-key-123",
});
const issueProfileToken = (
  baseDir: string,
  profile: NonNullable<Parameters<typeof issueDeviceBootstrapToken>[0]>["profile"],
) => issueDeviceBootstrapToken({ baseDir, profile });
const readCompletion = (baseDir: string, setupId: string) =>
  readDevicePairSetupCompletion({ baseDir, setupId });
const confirmCompletion = (baseDir: string, setupId: string) =>
  confirmDevicePairSetupCompletionDelivery({ baseDir, setupId, deviceId: "device-123" });

async function verifyBootstrapToken(
  baseDir: string,
  token: string,
  overrides: Partial<Parameters<typeof verifyDeviceBootstrapToken>[0]> = {},
) {
  return await verifyDeviceBootstrapToken({
    token,
    deviceId: "device-123",
    publicKey: "public-key-123",
    role: "node",
    scopes: [],
    baseDir,
    ...overrides,
  });
}

async function expectVerification(
  baseDir: string,
  token: string,
  ok: boolean,
  overrides: Partial<Parameters<typeof verifyDeviceBootstrapToken>[0]> = {},
) {
  await expect(verifyBootstrapToken(baseDir, token, overrides)).resolves.toEqual(
    ok ? { ok: true } : { ok: false, reason: "bootstrap_token_invalid" },
  );
}

function consumeBootstrapToken(
  baseDir: string,
  token: string,
  overrides: Partial<Parameters<typeof consumeDeviceBootstrapTokenWithSetupCompletion>[0]> = {},
) {
  return consumeDeviceBootstrapTokenWithSetupCompletion({
    baseDir,
    token,
    deviceId: "device-123",
    completedAtMs: 1_000,
    ...overrides,
  });
}

async function issueCloudWorkerSetupToken(baseDir: string) {
  const issued = await issueSetupToken(baseDir, CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE);
  const { db } = openDatabase(baseDir);
  db.prepare(
    `INSERT INTO worker_environments (
      environment_id, provider_id, profile_id, profile_snapshot_json,
      provision_operation_id, node_setup_id, state,
      created_at_ms, updated_at_ms, state_changed_at_ms
    ) VALUES (?, 'test-provider', 'test-profile', '{}', ?, ?, 'provisioning', ?, ?, ?)`,
  ).run(issued.setupId, `provision:${issued.setupId}`, issued.setupId, 1_000, 1_000, 1_000);
  return issued;
}

async function consumeCloudWorkerSetupToken(baseDir: string) {
  const issued = await issueCloudWorkerSetupToken(baseDir);
  await verifyBootstrapToken(baseDir, issued.token);
  await consumeBootstrapToken(baseDir, issued.token, { admitsCloudWorkerSetup: () => true });
  return issued;
}

function setWorkerState(baseDir: string, setupId: string, state: string) {
  openDatabase(baseDir)
    .db.prepare("UPDATE worker_environments SET state = ? WHERE node_setup_id = ?")
    .run(state, setupId);
}

afterEach(async () => {
  vi.useRealTimers();
  resetLogger();
  setLoggerOverride(null);
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("device bootstrap tokens", () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await createTempDir();
  });

  it("issues bootstrap tokens and persists them with a ten-minute expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));

    const issued = await issueDeviceBootstrapToken({ baseDir });

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(issued.expiresAtMs).toBe(Date.now() + 10 * 60 * 1000);
    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]).toMatchObject({
      token: issued.token,
      ts: Date.now(),
      issuedAtMs: Date.now(),
      profile: {
        roles: ["node", "operator"],
        scopes: [
          "operator.approvals",
          "operator.questions",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
      },
    });
  });
  it("keeps cloud-worker setup credentials valid for the enrollment backstop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));
    const issuedAtMs = Date.now();
    const issued = await issueCloudWorkerSetupToken(baseDir);
    expect(issued.expiresAtMs).toBe(issuedAtMs + MAX_NODE_BOOTSTRAP_TIMEOUT_MS);

    vi.setSystemTime(issuedAtMs + 10 * 60 * 1000 + 1);
    await expectVerification(baseDir, issued.token, true);
    await expect(
      ensureDevicePairSetupBootstrapToken({
        baseDir,
        setupId: issued.setupId,
        profile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      }),
    ).resolves.toEqual({ status: "pending", ...issued });
    const context = boundIdentity(baseDir, issued.token);
    await expect(getBoundDeviceBootstrapContext(context)).resolves.toMatchObject({
      setupId: issued.setupId,
      profile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    await expect(
      consumeBootstrapToken(baseDir, issued.token, {
        completedAtMs: Date.now(),
        admitsCloudWorkerSetup: () => true,
      }),
    ).resolves.toMatchObject({ completion: { setupId: issued.setupId } });

    vi.setSystemTime(issued.expiresAtMs);
    await expectVerification(baseDir, issued.token, true);
    vi.setSystemTime(issued.expiresAtMs + 1);
    await expect(getBoundDeviceBootstrapContext(context)).resolves.toBeNull();
    await expect(
      consumeBootstrapToken(baseDir, issued.token, { completedAtMs: Date.now() }),
    ).resolves.toBeNull();
    await expectVerification(baseDir, issued.token, false);
  });

  it("keeps non-cloud setup credentials limited to ten minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));
    const issued = await issueSetupToken(baseDir);
    expect(issued.expiresAtMs).toBe(Date.now() + 10 * 60 * 1000);
    vi.setSystemTime(issued.expiresAtMs);
    await expectVerification(baseDir, issued.token, true);
    vi.setSystemTime(issued.expiresAtMs + 1);
    await expect(
      consumeBootstrapToken(baseDir, issued.token, { completedAtMs: Date.now() }),
    ).resolves.toBeNull();
    await expectVerification(baseDir, issued.token, false);
  });

  it("reuses one setup bearer until the exact handoff completes", async () => {
    const setupId = "worker-environment-setup";
    const first = await ensureDevicePairSetupBootstrapToken({
      baseDir,
      setupId,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const replay = await ensureDevicePairSetupBootstrapToken({
      baseDir,
      setupId,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });

    expect(first).toMatchObject({ status: "pending", setupId });
    expect(replay).toEqual(first);
    const database = openDatabase(baseDir);
    database.db
      .prepare(
        `INSERT INTO device_pair_setup_completions (
          setup_id, device_id, access, completed_at_ms, delivery_state, retain_until_ms
        ) VALUES (?, ?, 'node', ?, 'confirmed', ?)`,
      )
      .run(setupId, "cloud-device", Date.now(), Date.now() + 10_000);
    await expect(
      ensureDevicePairSetupBootstrapToken({
        baseDir,
        setupId,
        profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      }),
    ).resolves.toEqual({ status: "completed", setupId, deviceId: "cloud-device" });
  });

  it("adds setup correlation storage only on first setup issuance", async () => {
    const databaseOptions = { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } };
    const initial = openOpenClawStateDatabase(databaseOptions);
    initial.db.exec("ALTER TABLE device_bootstrap_tokens DROP COLUMN setup_id;");
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    await issueDeviceBootstrapToken({ baseDir });
    const afterGenericIssue = openOpenClawStateDatabase(databaseOptions);
    expect(tableHasColumn(afterGenericIssue.db, "device_bootstrap_tokens", "setup_id")).toBe(false);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    const setup = await issueSetupToken(baseDir);
    const afterSetupIssue = openOpenClawStateDatabase(databaseOptions);
    expect(tableHasColumn(afterSetupIssue.db, "device_bootstrap_tokens", "setup_id")).toBe(true);
    expect(loadDeviceBootstrapTokenRecords(baseDir)[setup.token]?.setupId).toBe(setup.setupId);
  });

  // `openclaw qr --voice-node` issues through the same setup boundary. Correlation
  // must never gate issuance on a profile allowlist or that command stops working.
  it.each([
    ["voice node", VOICE_NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE],
    ["full access", FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE],
    ["node", NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE],
  ] as const)("issues a correlated %s setup credential", async (_label, profile) => {
    const issued = await issueDevicePairSetupBootstrapToken({ baseDir, profile });
    expect(issued.setupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]?.profile).toEqual(profile);
  });

  it("records uncertain delivery while consuming, then confirms the handoff", async () => {
    const issued = await issueSetupToken(baseDir);
    await verifyBootstrapToken(baseDir, issued.token);
    await consumeBootstrapToken(baseDir, issued.token);
    await expectVerification(baseDir, issued.token, false);

    await expect(readCompletion(baseDir, issued.setupId)).resolves.toMatchObject({
      setupId: issued.setupId,
      deviceId: "device-123",
      access: "node",
      completedAtMs: 1_000,
      deliveryState: "uncertain",
    });
    await expect(confirmCompletion(baseDir, issued.setupId)).resolves.toMatchObject({
      deliveryState: "confirmed",
    });
    await expect(readCompletion(baseDir, "some-other-setup")).resolves.toBeNull();
  });

  it("refuses first cloud-worker setup completion without a live admission predicate", async () => {
    const issued = await issueCloudWorkerSetupToken(baseDir);
    await verifyBootstrapToken(baseDir, issued.token);
    await expect(
      consumeBootstrapToken(baseDir, issued.token, { completedAtMs: Date.now() }),
    ).resolves.toBeNull();
    await expect(readCompletion(baseDir, issued.setupId)).resolves.toBeNull();
    const { db } = openDatabase(baseDir);
    expect(
      executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db)
          .selectFrom("worker_environments")
          .select("node_device_id")
          .where("node_setup_id", "=", issued.setupId),
      ),
    ).toEqual({ node_device_id: null });
  });

  it("retains an uncertain cloud-worker setup only for its exact device until delivery", async () => {
    const unbound = await issueCloudWorkerSetupToken(baseDir);
    await verifyBootstrapToken(baseDir, unbound.token);
    await expect(
      revokeDeviceBootstrapToken({ baseDir, token: unbound.token }),
    ).resolves.toMatchObject({ removed: true });
    const issued = await issueCloudWorkerSetupToken(baseDir);

    await expectVerification(baseDir, issued.token, true);
    await expect(
      consumeBootstrapToken(baseDir, issued.token, {
        admitsCloudWorkerSetup: () => true,
      }),
    ).resolves.toMatchObject({
      completion: { setupId: issued.setupId, deviceId: "device-123", deliveryState: "uncertain" },
    });
    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]?.deviceId).toBe("device-123");
    await expect(revokeDeviceBootstrapToken({ baseDir, token: issued.token })).resolves.toEqual({
      removed: false,
    });
    await expectVerification(baseDir, issued.token, true);
    await expectVerification(baseDir, issued.token, false, {
      deviceId: "different-device",
      publicKey: "different-public-key",
    });
    await expect(
      consumeBootstrapToken(baseDir, issued.token, {
        deviceId: "different-device",
      }),
    ).resolves.toBeNull();

    await expect(
      consumeBootstrapToken(baseDir, issued.token, { completedAtMs: 2_000 }),
    ).resolves.toMatchObject({
      completion: { deviceId: "device-123", completedAtMs: 2_000, deliveryState: "uncertain" },
    });
    await expect(confirmCompletion(baseDir, issued.setupId)).resolves.toMatchObject({
      deliveryState: "confirmed",
    });
    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]).toBeUndefined();
    await expectVerification(baseDir, issued.token, false);
  });

  it("replays uncertain cloud-worker setup for its bound device in attached until confirmation", async () => {
    const issued = await consumeCloudWorkerSetupToken(baseDir);
    setWorkerState(baseDir, issued.setupId, "attached");

    await expect(
      consumeBootstrapToken(baseDir, issued.token, { completedAtMs: 2_000 }),
    ).resolves.toMatchObject({
      completion: { deviceId: "device-123", completedAtMs: 2_000, deliveryState: "uncertain" },
    });
    await confirmCompletion(baseDir, issued.setupId);
    await expect(
      consumeBootstrapToken(baseDir, issued.token, { completedAtMs: 3_000 }),
    ).resolves.toBeNull();
    await expectVerification(baseDir, issued.token, false);
  });

  it("rejects first cloud-worker setup-device binding outside provisioning in bootstrapping", async () => {
    const issued = await issueCloudWorkerSetupToken(baseDir);
    await verifyBootstrapToken(baseDir, issued.token);
    setWorkerState(baseDir, issued.setupId, "bootstrapping");

    await expect(consumeBootstrapToken(baseDir, issued.token)).rejects.toThrow(
      "Cloud worker setup completion owner is no longer pending",
    );
  });

  it.each(["destroyed", "destruction requested"])(
    "rejects uncertain setup retries when %s",
    async (state) => {
      const issued = await consumeCloudWorkerSetupToken(baseDir);
      if (state === "destroyed") {
        setWorkerState(baseDir, issued.setupId, state);
      } else {
        openDatabase(baseDir)
          .db.prepare(
            "UPDATE worker_environments SET destroy_requested_at_ms = ? WHERE node_setup_id = ?",
          )
          .run(2_000, issued.setupId);
      }

      await expect(
        consumeBootstrapToken(baseDir, issued.token, { completedAtMs: 2_000 }),
      ).rejects.toThrow("Cloud worker setup completion owner is no longer pending");
      await expect(readCompletion(baseDir, issued.setupId)).resolves.toMatchObject({
        deliveryState: "uncertain",
        completedAtMs: 1_000,
      });
    },
  );

  // Databases written before this table shipped stay at the same schema
  // version, so the feature owner has to create it on first use rather than
  // the state schema refusing to open.
  it("creates the completion table on first use in an existing state database", async () => {
    const issued = await issueSetupToken(baseDir);
    await verifyBootstrapToken(baseDir, issued.token);
    const { db } = openDatabase(baseDir);
    db.exec("DROP TABLE IF EXISTS device_pair_setup_completions");

    await consumeBootstrapToken(baseDir, issued.token, { completedAtMs: Date.now() });

    await expect(readCompletion(baseDir, issued.setupId)).resolves.toMatchObject({
      setupId: issued.setupId,
      access: "node",
    });
  });

  // Retention outlives the credential's own 10-minute TTL, so a client that
  // waits for the full setup window can still reconcile after it lapses.
  it.each([
    ["inside retention", 19 * 60 * 1000, true],
    ["past retention", 20 * 60 * 1000, false],
  ] as const)("reports a completion %s", async (_label, elapsedMs, expectFound) => {
    const recordedAtMs = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(recordedAtMs));
    const issued = await issueSetupToken(baseDir);
    await verifyBootstrapToken(baseDir, issued.token);
    await consumeBootstrapToken(baseDir, issued.token, { completedAtMs: recordedAtMs });
    vi.setSystemTime(new Date(recordedAtMs + elapsedMs));
    const found = await readCompletion(baseDir, issued.setupId);
    expect(found === null).toBe(!expectFound);
    if (!expectFound) {
      const { db } = openDatabase(baseDir);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db)
          .selectFrom("device_pair_setup_completions")
          .select("setup_id")
          .where("setup_id", "=", issued.setupId),
      );
      expect(row).toBeUndefined();
    }
  });

  it("rejects bootstrap token issuance when expiry would exceed the Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));

    await expect(issueDeviceBootstrapToken({ baseDir })).rejects.toThrow(
      "Device bootstrap token expiry could not be resolved.",
    );
  });

  it("verifies valid bootstrap tokens and binds them to the first device identity", async () => {
    const issued = await issueDeviceBootstrapToken({ baseDir });

    await expectVerification(baseDir, `  ${issued.token}  `, true);
    await expectVerification(baseDir, issued.token, true);
    await expectVerification(baseDir, issued.token, false, {
      deviceId: "device-456",
      publicKey: "public-key-456",
    });

    const records = loadDeviceBootstrapTokenRecords(baseDir);
    expect(records[issued.token]?.token).toBe(issued.token);
    expect(records[issued.token]?.deviceId).toBe("device-123");
    expect(records[issued.token]?.publicKey).toBe("public-key-123");
  });

  it("rejects changing the requested profile while a bound use is pending", async () => {
    const issued = await issueProfileToken(baseDir, {
      roles: ["operator"],
      scopes: ["operator.approvals", "operator.read", "operator.write"],
    });

    await expectVerification(baseDir, issued.token, true, {
      role: "operator",
      scopes: ["operator.read"],
    });
    await expectVerification(baseDir, issued.token, false, {
      role: "operator",
      scopes: ["operator.write", "operator.approvals"],
    });
    await expectVerification(baseDir, issued.token, true, {
      role: "operator",
      scopes: ["operator.read"],
    });

    await expect(
      redeemDeviceBootstrapTokenProfile({
        baseDir,
        token: issued.token,
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({
      recorded: true,
      fullyRedeemed: false,
    });
    await expectVerification(baseDir, issued.token, true, {
      role: "operator",
      scopes: ["operator.write", "operator.approvals"],
    });
  });

  it("persists bootstrap profile purpose through binding", async () => {
    const issued = await issueProfileToken(baseDir, {
      roles: ["operator"],
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
      purpose: "control-ui",
    });

    await expectVerification(baseDir, issued.token, true, {
      role: "operator",
      scopes: ["operator.read"],
    });
    await expect(
      getBoundDeviceBootstrapProfile(boundIdentity(baseDir, issued.token)),
    ).resolves.toEqual({
      roles: ["operator"],
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
      purpose: "control-ui",
    });
  });

  it("reads an exact correlated setup only from its verified device binding", async () => {
    const issued = await issueSetupToken(baseDir, CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE);
    const contextParams = boundIdentity(baseDir, issued.token);

    await expect(getBoundDeviceBootstrapContext(contextParams)).resolves.toBeNull();
    await expectVerification(baseDir, issued.token, true);
    await expect(getBoundDeviceBootstrapContext(contextParams)).resolves.toEqual({
      profile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      setupId: issued.setupId,
    });
    await expect(
      getBoundDeviceBootstrapContext({ ...contextParams, deviceId: "other-device" }),
    ).resolves.toBeNull();
    await expect(getBoundDeviceBootstrapProfile(contextParams)).resolves.toEqual(
      CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    );
  });

  it("persists bootstrap redemption state across verification reloads", async () => {
    const issued = await issueProfileToken(baseDir, {
      roles: ["node"],
      scopes: [],
    });

    await expectVerification(baseDir, issued.token, true);
    await expect(
      redeemDeviceBootstrapTokenProfile({
        baseDir,
        token: issued.token,
        role: "node",
        scopes: [],
      }),
    ).resolves.toEqual({
      recorded: true,
      fullyRedeemed: true,
    });

    await expectVerification(baseDir, issued.token, false, {
      role: "operator",
      scopes: ["operator.approvals", "operator.read", "operator.write", "operator.talk.secrets"],
    });
  });

  it("clears outstanding bootstrap tokens on demand", async () => {
    const first = await issueDeviceBootstrapToken({ baseDir });
    const second = await issueDeviceBootstrapToken({ baseDir });

    await expect(clearDeviceBootstrapTokens({ baseDir })).resolves.toEqual({ removed: 2 });
    expect(loadDeviceBootstrapTokenRecords(baseDir)).toEqual({});

    await expectVerification(baseDir, first.token, false);

    await expectVerification(baseDir, second.token, false);
  });

  it("revokes a specific bootstrap token", async () => {
    const first = await issueDeviceBootstrapToken({ baseDir });
    const second = await issueDeviceBootstrapToken({ baseDir });

    const revoked = await revokeDeviceBootstrapToken({ baseDir, token: first.token });
    expect(revoked.removed).toBe(true);

    await expectVerification(baseDir, first.token, false);

    await expectVerification(baseDir, second.token, true);
  });

  it.each([
    ["blank role", "   ", []],
    ["scopes exceeding the issued profile", "operator", ["operator.admin"]],
    ["cross-role scope escalation", "node", ["operator.read"]],
  ] as const)("rejects %s without consuming the token", async (_label, role, scopes) => {
    const issued = await issueDeviceBootstrapToken({ baseDir });
    await expectVerification(baseDir, issued.token, false, { role, scopes });
    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]).toBeDefined();
  });

  it("requires the exact closed browser-owner profile before binding", async () => {
    const issued = await issueProfileToken(baseDir, CONTROL_UI_OWNER_BOOTSTRAP_PROFILE);

    await expectVerification(baseDir, issued.token, false, {
      role: "operator",
      scopes: ["operator.admin"],
    });
    await expectVerification(baseDir, issued.token, true, {
      role: "operator",
      scopes: [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES],
    });
  });

  it("supports explicitly bound bootstrap profiles", async () => {
    const issued = await issueProfileToken(baseDir, {
      roles: [" operator ", "operator"],
      scopes: ["operator.read", " operator.read "],
    });

    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]?.profile).toEqual({
      roles: ["operator"],
      scopes: ["operator.read"],
    });

    await expectVerification(baseDir, issued.token, true, {
      role: "operator",
      scopes: ["operator.read"],
    });
  });

  it("bounds explicitly issued bootstrap profiles to handoff scopes", async () => {
    const issued = await issueProfileToken(baseDir, overbroadBootstrapProfile());

    await expectVerification(baseDir, issued.token, true, {
      role: "operator",
      scopes: ["operator.read"],
    });
    await expect(
      getBoundDeviceBootstrapProfile(boundIdentity(baseDir, issued.token)),
    ).resolves.toEqual({
      roles: ["node", "operator"],
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
    });
    await expectVerification(baseDir, issued.token, false, {
      role: "operator",
      scopes: ["operator.admin"],
    });
  });

  it("retains admin only for an explicitly full-mobile handoff profile", async () => {
    const issued = await issueProfileToken(baseDir, {
      roles: ["node", "operator"],
      scopes: ["operator.admin", "operator.pairing", "operator.read"],
      purpose: "mobile-full",
    });

    await expectVerification(baseDir, issued.token, true, {
      role: "operator",
      scopes: ["operator.admin"],
    });
    await expect(
      getBoundDeviceBootstrapProfile(boundIdentity(baseDir, issued.token)),
    ).resolves.toEqual({
      roles: ["node", "operator"],
      scopes: ["operator.admin", "operator.read", "operator.write"],
      purpose: "mobile-full",
    });
  });

  it("logs when issued bootstrap profiles strip overbroad scopes", async () => {
    const logPath = path.join(baseDir, "bootstrap.log");
    setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logPath });

    await issueProfileToken(baseDir, {
      roles: ["node", "operator"],
      scopes: ["node.exec", "operator.admin", "operator.read"],
    });

    // The file transport appends asynchronously; drain it before reading.
    await flushLogger();
    const content = await fs.readFile(logPath, "utf8");
    expect(content).toContain("bootstrap_token_scopes_stripped");
    expect(content).toContain("node.exec");
    expect(content).toContain("operator.admin");
    expect(content).toContain("operator.read");
  });

  it("bounds redeemed bootstrap profiles to handoff scopes", async () => {
    const issued = await issueProfileToken(baseDir, {
      roles: ["operator"],
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
    });

    await expect(
      redeemDeviceBootstrapTokenProfile({
        baseDir,
        token: issued.token,
        role: "operator",
        scopes: [
          "operator.admin",
          "operator.approvals",
          "operator.pairing",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
      }),
    ).resolves.toEqual({ recorded: true, fullyRedeemed: true });

    expect(loadDeviceBootstrapTokenRecords(baseDir)[issued.token]?.redeemedProfile).toEqual({
      roles: ["operator"],
      scopes: ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"],
    });
  });

  it("rejects blank or unknown tokens", async () => {
    await issueDeviceBootstrapToken({ baseDir });

    await expectVerification(baseDir, "   ", false);

    await expectVerification(baseDir, "missing-token", false);
  });

  it("accepts equivalent public key encodings after binding the bootstrap token", async () => {
    const identity = loadOrCreateDeviceIdentity({
      env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
    });
    const issued = await issueDeviceBootstrapToken({ baseDir });
    const rawPublicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);

    await expectVerification(baseDir, issued.token, true, {
      deviceId: identity.deviceId,
      publicKey: identity.publicKeyPem,
    });
    await expectVerification(baseDir, issued.token, true, {
      deviceId: identity.deviceId,
      publicKey: rawPublicKey,
    });
    await expect(
      getBoundDeviceBootstrapProfile({
        token: issued.token,
        deviceId: identity.deviceId,
        publicKey: rawPublicKey,
        baseDir,
      }),
    ).resolves.toEqual({
      roles: ["node", "operator"],
      scopes: [
        "operator.approvals",
        "operator.questions",
        "operator.read",
        "operator.talk.secrets",
        "operator.write",
      ],
    });
  });

  it("fails closed for profileless records and prunes expired tokens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));
    const tokenTtlMs = 10 * 60 * 1000;
    persistDeviceBootstrapTokenRecords(
      {
        "profileless-token": {
          token: "profileless-token",
          ts: Date.now(),
          issuedAtMs: Date.now(),
        },
        "expired-token": {
          token: "expired-token",
          ts: Date.now() - tokenTtlMs - 1,
          issuedAtMs: Date.now() - tokenTtlMs - 1,
        },
      },
      baseDir,
    );

    await expectVerification(baseDir, "profileless-token", false);
    await expectVerification(baseDir, "expired-token", false);
  });
});
