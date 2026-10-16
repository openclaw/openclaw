// Covers fail-closed Doctor import of the retired Web Push JSON stores.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  hashWebPushEndpoint,
  listWebPushSubscriptions,
  readPersistedVapidKeyPair,
  DEFAULT_WEB_PUSH_VAPID_SUBJECT,
  type VapidKeyPair,
  type WebPushSubscription,
} from "./push-web-store.js";
import {
  webPushSubscriptionToRow,
  WEB_PUSH_VAPID_STATE_KEY,
  type WebPushDatabase,
} from "./push-web-store.records.js";
import {
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "./state-migrations.doctor.js";
import { detectLegacyWebPush, migrateLegacyWebPush } from "./state-migrations.web-push.js";

describe("legacy Web Push Doctor migration", () => {
  let stateDir: string;
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      envSnapshot?.restore();
      envSnapshot = undefined;
      cleanup();
    });
  });

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-web-push-migration-");
    envSnapshot ??= captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_VAPID_SUBJECT"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  });

  function subscription(overrides: Partial<WebPushSubscription> = {}): WebPushSubscription {
    return {
      subscriptionId: "c0a80101-0000-4000-8000-000000000001",
      endpoint: "https://push.example.com/send/legacy",
      keys: { p256dh: "legacy-p256dh", auth: "legacy-auth" },
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
      ...overrides,
    };
  }

  function vapidKeys(overrides: Partial<VapidKeyPair> = {}): VapidKeyPair {
    return {
      publicKey: "legacy-public-key",
      privateKey: "legacy-private-key",
      subject: "https://openclaw.ai",
      ...overrides,
    };
  }

  async function writeLegacyState(
    params: { subscriptions?: unknown; vapid?: unknown },
    targetDir = stateDir,
  ) {
    const pushDir = path.join(targetDir, "push");
    await fsp.mkdir(pushDir, { recursive: true });
    const subscriptionsPath = path.join(pushDir, "web-push-subscriptions.json");
    const vapidKeysPath = path.join(pushDir, "vapid-keys.json");
    if (params.subscriptions !== undefined) {
      const subscriptionsByEndpointHash = Array.isArray(params.subscriptions)
        ? Object.fromEntries(
            (params.subscriptions as readonly WebPushSubscription[]).map((entry) => [
              hashWebPushEndpoint(entry.endpoint),
              entry,
            ]),
          )
        : params.subscriptions;
      await fsp.writeFile(
        subscriptionsPath,
        JSON.stringify({ subscriptionsByEndpointHash }, null, 2),
        "utf8",
      );
    }
    if (params.vapid !== undefined) {
      await fsp.writeFile(vapidKeysPath, JSON.stringify(params.vapid, null, 2), "utf8");
    }
    return { subscriptionsPath, vapidKeysPath };
  }

  function writeSubscriptions(subscriptions = [subscription()], vapid?: unknown) {
    return writeLegacyState({ subscriptions, vapid });
  }

  function expectFiles(exists: boolean, ...sources: string[]) {
    for (const source of sources) {
      expect(fs.existsSync(source)).toBe(exists);
    }
  }

  function seedSubscription(endpointHash: string, value: WebPushSubscription): void {
    const database = openOpenClawStateDatabase();
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<WebPushDatabase>(database.db)
        .insertInto("web_push_subscriptions")
        .values(webPushSubscriptionToRow({ endpointHash, subscription: value })),
    );
  }

  function seedVapid(value: VapidKeyPair): void {
    writeConfigMachineState(WEB_PUSH_VAPID_STATE_KEY, value);
  }

  function migrate(
    options: Omit<Parameters<typeof migrateLegacyWebPush>[0], "stateDir" | "detected"> = {},
  ) {
    return migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
      ...options,
    });
  }

  it("detects original and interrupted-claim files only for explicit Doctor repair", async () => {
    const { subscriptionsPath } = await writeSubscriptions([]);
    expect(detectLegacyWebPush({ stateDir }).hasLegacy).toBe(false);
    expect(detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(true);

    await fsp.rename(subscriptionsPath, `${subscriptionsPath}.doctor-importing`);
    expect(detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(true);
  });

  it("requires exclusive state ownership before reading or committing legacy state", async () => {
    const { subscriptionsPath } = await writeSubscriptions();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 10,
      port: 18_789,
      timeoutMs: 100,
    });
    if (!gatewayLock) {
      throw new Error("expected test Gateway lock");
    }

    let blocked: Awaited<ReturnType<typeof migrateLegacyWebPush>>;
    try {
      blocked = await migrate({ env });
    } finally {
      await gatewayLock.release();
    }

    expect(blocked.warnings[0]).toContain("OpenClaw state database is busy");
    expect(fs.existsSync(subscriptionsPath)).toBe(true);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);

    const retry = await migrate({ env });
    expect(retry.warnings).toEqual([]);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([subscription()]);
    expect(fs.existsSync(subscriptionsPath)).toBe(false);
  });

  it("routes explicit Doctor repair through the Web Push SQLite importer", async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { "worker-1": {} } },
      session: { mainKey: "desk" },
    };
    const env = {
      ...process.env,
      HOME: stateDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_AGENT_DIR: undefined,
      PI_CODING_AGENT_DIR: undefined,
    };
    const expectedSubscription = subscription();
    const expectedVapid = vapidKeys();
    const paths = await writeSubscriptions([expectedSubscription], expectedVapid);

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => stateDir,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(detected.webPush.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Web Push subscriptions and VAPID identity: legacy JSON → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({
      detected,
      config: cfg,
      env,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(await listWebPushSubscriptions(stateDir)).toStrictEqual([expectedSubscription]);
    expect(await readPersistedVapidKeyPair(stateDir)).toStrictEqual(expectedVapid);
    expectFiles(false, paths.subscriptionsPath, paths.vapidKeysPath);
  });

  it.each([
    ["blank injected subject", undefined, "   ", DEFAULT_WEB_PUSH_VAPID_SUBJECT],
    [
      "padded injected subject",
      undefined,
      "  mailto:injected@example.com  ",
      "mailto:injected@example.com",
    ],
    [
      "padded legacy subject",
      "  mailto:legacy@example.com  ",
      "mailto:injected@example.com",
      "mailto:legacy@example.com",
    ],
  ])("normalizes a %s", async (_label, legacySubject, injectedSubject, expectedSubject) => {
    setTestEnvValue("OPENCLAW_VAPID_SUBJECT", "mailto:ambient@example.com");
    const legacyKeys = vapidKeys({ subject: legacySubject ?? "" });
    if (legacySubject === undefined) {
      delete (legacyKeys as Partial<VapidKeyPair>).subject;
    }
    await writeLegacyState({ vapid: legacyKeys });

    const result = await migrate({
      env: { ...process.env, OPENCLAW_VAPID_SUBJECT: injectedSubject },
    });

    expect(result.warnings).toEqual([]);
    expect((await readPersistedVapidKeyPair(stateDir))?.subject).toBe(expectedSubject);
  });

  it("rejects a present non-string legacy VAPID subject", async () => {
    const paths = await writeLegacyState({ vapid: { ...vapidKeys(), subject: 42 } });

    const result = await migrate({
      env: { ...process.env, OPENCLAW_VAPID_SUBJECT: "mailto:fallback@example.com" },
    });

    expect(result.warnings[0]).toContain("VAPID keys are invalid");
    expect(await readPersistedVapidKeyPair(stateDir)).toBeNull();
    expect(fs.existsSync(paths.vapidKeysPath)).toBe(true);
  });

  it("rejects either malformed file without importing its valid pair", async () => {
    const paths = await writeSubscriptions([subscription()], { publicKey: "incomplete" });

    const result = await migrate();

    expect(result.warnings[0]).toContain("VAPID keys are invalid");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
    expect(await readPersistedVapidKeyPair(stateDir)).toBeNull();
    expectFiles(true, paths.subscriptionsPath, paths.vapidKeysPath);
  });

  it("rejects a forged endpoint hash and duplicate subscription ids", async () => {
    await writeLegacyState({ subscriptions: { forged: subscription() } });
    let result = await migrate();
    expect(result.warnings[0]).toContain("subscription is invalid");

    const first = subscription();
    const second = subscription({ endpoint: "https://push.example.com/send/second" });
    await writeSubscriptions([first, second]);
    result = await migrate();
    expect(result.warnings[0]).toContain("duplicate subscription id");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
  });

  it("keeps newer SQLite fields while preserving the earliest creation time", async () => {
    const legacy = subscription({ createdAtMs: 100, updatedAtMs: 200 });
    const canonical = subscription({
      keys: { p256dh: "canonical-p256dh", auth: "canonical-auth" },
      createdAtMs: 150,
      updatedAtMs: 300,
    });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    await writeSubscriptions([legacy]);

    const result = await migrate();

    expect(result.warnings).toEqual([]);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([{ ...canonical, createdAtMs: 100 }]);
  });

  it("retries a committed newer-row merge after normalizing its creation time", async () => {
    const canonical = subscription({ createdAtMs: 100, updatedAtMs: 200 });
    const legacy = subscription({
      keys: { p256dh: "newer-p256dh", auth: "newer-auth" },
      createdAtMs: 500,
      updatedAtMs: 600,
    });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    const { subscriptionsPath, vapidKeysPath } = await writeSubscriptions([legacy], vapidKeys());

    const first = await migrate({
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    const claims = [subscriptionsPath, vapidKeysPath].map((source) => `${source}.doctor-importing`);
    expectFiles(true, ...claims);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([{ ...legacy, createdAtMs: 100 }]);

    const retry = await migrate();
    expect(retry.warnings).toEqual([]);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([{ ...legacy, createdAtMs: 100 }]);
    expectFiles(false, ...claims);
    expect(await readPersistedVapidKeyPair(stateDir)).toEqual(vapidKeys());
  });

  it("rolls back equal-timestamp divergence and VAPID identity conflicts", async () => {
    const canonical = subscription({ keys: { p256dh: "canonical", auth: "canonical" } });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    seedVapid(vapidKeys({ publicKey: "canonical-public", privateKey: "canonical-private" }));
    const paths = await writeSubscriptions([subscription()], vapidKeys());

    const result = await migrate();

    expect(result.warnings[0]).toContain("diverges at the same timestamp");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([canonical]);
    expect((await readPersistedVapidKeyPair(stateDir))?.publicKey).toBe("canonical-public");
    expectFiles(true, paths.subscriptionsPath, paths.vapidKeysPath);
    expectFiles(
      false,
      `${paths.subscriptionsPath}.doctor-importing`,
      `${paths.vapidKeysPath}.doctor-importing`,
    );
  });

  it("rolls back subscription changes when only VAPID conflicts", async () => {
    seedVapid(vapidKeys({ publicKey: "canonical-public", privateKey: "canonical-private" }));
    await writeSubscriptions([subscription()], vapidKeys());

    const result = await migrate();

    expect(result.warnings[0]).toContain("VAPID identity conflicts");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
  });

  it("rejects a subscription id already owned by another endpoint", async () => {
    const canonical = subscription({ endpoint: "https://push.example.com/canonical" });
    const legacy = subscription({ endpoint: "https://push.example.com/legacy" });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    const { subscriptionsPath } = await writeSubscriptions([legacy]);

    const result = await migrate();

    expect(result.warnings[0]).toContain("subscription id conflicts");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([canonical]);
    expect(fs.existsSync(subscriptionsPath)).toBe(true);
  });

  it("fails before database mutation when a source changes after parsing", async () => {
    const { subscriptionsPath } = await writeSubscriptions();

    const result = await migrate({
      beforeVerify: () => fs.appendFileSync(subscriptionsPath, "\n"),
    });

    expect(result.warnings[0]).toContain("source changed");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
    expect(fs.existsSync(subscriptionsPath)).toBe(true);
  });

  it("restores claimed sources without database mutation when claim verification fails", async () => {
    const { subscriptionsPath } = await writeSubscriptions();

    const result = await migrate({
      beforeClaim: () => fs.appendFileSync(subscriptionsPath, "\n"),
    });

    expect(result.warnings[0]).toContain("source changed before doctor could claim it");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
    expect(fs.existsSync(subscriptionsPath)).toBe(true);
    expect(fs.existsSync(`${subscriptionsPath}.doctor-importing`)).toBe(false);
  });

  it("refuses symlinked sources", async () => {
    const outside = path.join(stateDir, "outside.json");
    await fsp.writeFile(outside, JSON.stringify({ subscriptionsByEndpointHash: {} }), "utf8");
    const sourcePath = path.join(stateDir, "push", "web-push-subscriptions.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.symlink(outside, sourcePath);

    const result = await migrate();

    expect(result.warnings[0]).toContain("Failed reading legacy Web Push state");
    expect(fs.lstatSync(sourcePath).isSymbolicLink()).toBe(true);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
  });

  it("refuses a legacy store reached through a symlinked state-directory ancestor", async () => {
    if (process.platform === "win32") {
      return;
    }
    const outside = tempDirs.make("openclaw-web-push-outside-");
    const { subscriptionsPath } = await writeLegacyState(
      { subscriptions: [subscription()] },
      outside,
    );
    await fsp.symlink(path.join(outside, "push"), path.join(stateDir, "push"));

    const result = await migrate();

    expect(result.warnings[0]).toContain("Failed reading legacy Web Push state");
    expect(fs.existsSync(subscriptionsPath)).toBe(true);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
  });
});
