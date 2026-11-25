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
import { withGatewayLockHeld } from "./state-migrations.gateway-lock.test-support.js";
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

  function writeSubscriptions(subscriptions = [subscription()], vapid?: unknown, dir = stateDir) {
    return writeLegacyState({ subscriptions, vapid }, dir);
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

  async function expectMigration(warning?: string, options: Parameters<typeof migrate>[0] = {}) {
    const result = await migrate(options);
    expect(result.warnings).toEqual(warning ? [expect.stringContaining(warning)] : []);
  }

  async function expectStored(
    subscriptions: WebPushSubscription[] = [],
    vapid: VapidKeyPair | null = null,
  ) {
    expect(
      await Promise.all([listWebPushSubscriptions(stateDir), readPersistedVapidKeyPair(stateDir)]),
    ).toEqual([subscriptions, vapid]);
  }

  it.each([
    { source: "subscriptions", claimed: false },
    { source: "subscriptions", claimed: true },
    { source: "vapid", claimed: false },
    { source: "vapid", claimed: true },
  ] as const)(
    "retains malformed UTF-8 in $source without importing replacement characters (claim: $claimed)",
    async ({ source, claimed }) => {
      const paths = await writeLegacyState({
        subscriptions: [subscription({ keys: { p256dh: "utf8-marker", auth: "auth" } })],
        vapid: vapidKeys({ publicKey: "utf8-marker" }),
      });
      const sourcePath = source === "subscriptions" ? paths.subscriptionsPath : paths.vapidKeysPath;
      const bytes = await fsp.readFile(sourcePath);
      bytes[bytes.indexOf("utf8-marker")] = 0xff;
      await fsp.writeFile(sourcePath, bytes);
      const activePath = sourcePath + (claimed ? ".doctor-importing" : "");
      if (claimed) {
        await fsp.rename(sourcePath, activePath);
      }
      const result = await migrate();
      expect(result.changes).toEqual([]);
      expect(result.warningDisposition).toBe("recoverable");
      expect(result.warnings.join("\n")).toContain("must be valid UTF-8");
      expect(await fsp.readFile(activePath)).toEqual(bytes);
      expectFiles(
        true,
        activePath,
        source === "subscriptions" ? paths.vapidKeysPath : paths.subscriptionsPath,
      );
      await expectStored();
    },
  );

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
    const blocked = await withGatewayLockHeld(env, 18_789, () => migrate({ env }));
    expect(blocked.warnings[0]).toContain("OpenClaw state database is busy");
    expect(fs.existsSync(subscriptionsPath)).toBe(true);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
    await expectMigration(undefined, { env });
    expect(await listWebPushSubscriptions(stateDir)).toEqual([subscription()]);
    expect(fs.existsSync(subscriptionsPath)).toBe(false);
  });

  it("routes explicit Doctor repair through the Web Push SQLite importer", async () => {
    const cfg: OpenClawConfig = {};
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
    const result = await runLegacyStateMigrations({
      detected,
      config: cfg,
      env,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(result.warnings).toStrictEqual([]);
    await expectStored([expectedSubscription], expectedVapid);
    expectFiles(false, paths.subscriptionsPath, paths.vapidKeysPath);
  });

  it.each([
    ["blank injected subject", undefined, "   ", DEFAULT_WEB_PUSH_VAPID_SUBJECT],
    ["padded injected subject", undefined, "  mailto:i@example.com  ", "mailto:i@example.com"],
    [
      "padded legacy subject",
      "  mailto:l@example.com  ",
      "mailto:i@example.com",
      "mailto:l@example.com",
    ],
  ])("normalizes a %s", async (_label, legacySubject, injectedSubject, expectedSubject) => {
    setTestEnvValue("OPENCLAW_VAPID_SUBJECT", "mailto:ambient@example.com");
    const legacyKeys = vapidKeys({ subject: legacySubject ?? "" });
    if (legacySubject === undefined) {
      delete (legacyKeys as Partial<VapidKeyPair>).subject;
    }
    await writeLegacyState({ vapid: legacyKeys });
    await expectMigration(undefined, {
      env: { ...process.env, OPENCLAW_VAPID_SUBJECT: injectedSubject },
    });
    expect((await readPersistedVapidKeyPair(stateDir))?.subject).toBe(expectedSubject);
  });

  it.each([
    { invalid: "subject", warning: "VAPID keys are invalid" },
    { invalid: "keys", warning: "VAPID keys are invalid" },
    { invalid: "hash", warning: "subscription is invalid" },
    { invalid: "id", warning: "duplicate subscription id" },
  ])("rejects invalid $invalid without importing its valid pair", async ({ invalid, warning }) => {
    const subscriptions =
      invalid === "hash"
        ? { forged: subscription() }
        : [
            subscription(),
            ...(invalid === "id"
              ? [subscription({ endpoint: "https://push.example.com/second" })]
              : []),
          ];
    const vapid =
      invalid === "subject"
        ? { ...vapidKeys(), subject: 42 }
        : invalid === "keys"
          ? { publicKey: "incomplete" }
          : vapidKeys();
    const paths = await writeLegacyState({ subscriptions, vapid });
    await expectMigration(warning, {
      env: { ...process.env, OPENCLAW_VAPID_SUBJECT: "mailto:fallback@example.com" },
    });
    await expectStored();
    expectFiles(true, paths.subscriptionsPath, paths.vapidKeysPath);
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
    await expectMigration();
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
    await expectMigration("legacy cleanup failed", {
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    const claims = [subscriptionsPath, vapidKeysPath].map((source) => `${source}.doctor-importing`);
    expectFiles(true, ...claims);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([{ ...legacy, createdAtMs: 100 }]);
    await expectMigration();
    expect(await listWebPushSubscriptions(stateDir)).toEqual([{ ...legacy, createdAtMs: 100 }]);
    expectFiles(false, ...claims);
    expect(await readPersistedVapidKeyPair(stateDir)).toEqual(vapidKeys());
  });

  it("rolls back equal-timestamp divergence and VAPID identity conflicts", async () => {
    const canonical = subscription({ keys: { p256dh: "canonical", auth: "canonical" } });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    seedVapid(vapidKeys({ publicKey: "canonical-public", privateKey: "canonical-private" }));
    const paths = await writeSubscriptions([subscription()], vapidKeys());
    await expectMigration("diverges at the same timestamp");
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
    await expectMigration("VAPID identity conflicts");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
  });

  it("rejects a subscription id already owned by another endpoint", async () => {
    const canonical = subscription({ endpoint: "https://push.example.com/canonical" });
    const legacy = subscription({ endpoint: "https://push.example.com/legacy" });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    const { subscriptionsPath } = await writeSubscriptions([legacy]);
    await expectMigration("subscription id conflicts");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([canonical]);
    expect(fs.existsSync(subscriptionsPath)).toBe(true);
  });

  it.each(["beforeVerify", "beforeClaim"] as const)(
    "preserves state when source changes %s",
    async (hook) => {
      const { subscriptionsPath } = await writeSubscriptions();
      await expectMigration(
        hook === "beforeClaim" ? "source changed before doctor could claim it" : "source changed",
        { [hook]: () => fs.appendFileSync(subscriptionsPath, "\n") },
      );
      expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
      expect(fs.existsSync(subscriptionsPath)).toBe(true);
      if (hook === "beforeClaim") {
        expect(fs.existsSync(`${subscriptionsPath}.doctor-importing`)).toBe(false);
      }
    },
  );

  it.each([false, true])("refuses symlinked sources (ancestor: %s)", async (ancestor) => {
    if (ancestor && process.platform === "win32") {
      return;
    }
    const outside = tempDirs.make("openclaw-web-push-outside-");
    const { subscriptionsPath } = await writeSubscriptions([subscription()], undefined, outside);
    const link = path.join(stateDir, "push", ...(ancestor ? [] : ["web-push-subscriptions.json"]));
    await fsp.mkdir(path.dirname(link), { recursive: true });
    await fsp.symlink(ancestor ? path.join(outside, "push") : subscriptionsPath, link);
    await expectMigration("Failed reading legacy Web Push state");
    expectFiles(true, subscriptionsPath);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    await expectStored();
  });
});
