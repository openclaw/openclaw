import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { WebPushNotificationPreferences } from "../../../packages/gateway-protocol/src/schema/push.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareOpenClawStateDatabaseSchema } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { pushHandlers } from "./push.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it("preserves released Detailed preferences without preview consent until each owner opts in", async () => {
  const stateDir = tempDirs.make("openclaw-push-upgrade-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath));
  const fixture = new DatabaseSync(databasePath);
  const profileIds = new Map<string, string>();
  try {
    // This is a dump from the released handlers, including their complete v20 schema.
    fixture.exec(
      fs.readFileSync(
        new URL(
          "../../../test/fixtures/push-preferences-upgrade/openclaw-2026.10.2.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    for (const row of fixture
      .prepare("SELECT device_id, user_profile_id FROM web_push_subscriptions")
      .all()) {
      if (typeof row.device_id !== "string" || typeof row.user_profile_id !== "string") {
        throw new Error("Released fixture must have durable device/profile bindings");
      }
      profileIds.set(row.device_id, row.user_profile_id);
    }
  } finally {
    fixture.close();
  }
  // Use the same schema admission owner as startup before exposing the old store to RPCs.
  await prepareOpenClawStateDatabaseSchema();

  const account = {
    categories: {
      approvalRequested: true,
      agentFinished: true,
      agentQuestion: true,
      humanMentioned: false,
      scheduledTaskFailed: false,
    },
    detailLevel: "detailed",
    quietHours: { enabled: false, startMinute: 1320, endMinute: 420, timeZone: "UTC" },
    agentIds: [],
  } satisfies WebPushNotificationPreferences;
  const detailedDevice = {
    enabled: true,
    label: "Detailed browser",
    categories: { agentFinished: true, agentQuestion: true },
    detailLevel: "detailed" as const,
  };

  async function invoke(
    deviceId: string,
    method: "push.web.preferences.get" | "push.web.preferences.set",
    params: Record<string, unknown> = {},
  ) {
    const profileId = profileIds.get(deviceId);
    if (!profileId) {
      throw new Error(`Missing released profile for ${deviceId}`);
    }
    const respond = vi.fn();
    await pushHandlers[method]({
      req: { type: "req", id: "upgrade", method },
      params: { endpoint: `https://push.example.test/${deviceId}`, ...params },
      client: {
        connId: deviceId,
        connect: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          device: {
            id: deviceId,
            publicKey: "synthetic",
            signature: "synthetic",
            signedAt: 1,
            nonce: "synthetic",
          },
        },
        authenticatedUserProfile: { profileId, displayName: null, hasAvatar: false, updatedAt: 1 },
      },
      respond,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => ({}),
        broadcastToConnIds: vi.fn(),
        getClientConnIds: () => new Set(),
      },
    });
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, expect.any(Object), undefined);
    return respond.mock.calls[0]?.[1];
  }

  async function expectLegacyDetailed(
    expectedAccount: WebPushNotificationPreferences,
    deviceLabel: string,
  ) {
    expect(await invoke("stable-inherited", "push.web.preferences.get")).toEqual({
      durableIdentity: true,
      user: expectedAccount,
      device: { enabled: true, label: "Inherited browser" },
      effective: { ...expectedAccount, enabled: true, label: "Inherited browser" },
    });
    expect(await invoke("stable-detailed", "push.web.preferences.get")).toEqual({
      durableIdentity: true,
      user: expectedAccount,
      device: { ...detailedDevice, label: deviceLabel },
      effective: { ...expectedAccount, enabled: true, label: deviceLabel },
    });
  }

  await expectLegacyDetailed(account, "Detailed browser");
  const defaults = {
    ...account,
    categories: { ...account.categories, agentFinished: false, agentQuestion: false },
    detailLevel: "private",
  };
  expect(await invoke("stable-default", "push.web.preferences.get")).toEqual({
    durableIdentity: true,
    user: defaults,
    device: { enabled: true, label: "" },
    effective: { ...defaults, enabled: true, label: "" },
  });

  const editedAccount = { ...account, quietHours: { ...account.quietHours, startMinute: 1260 } };
  await invoke("stable-inherited", "push.web.preferences.set", {
    scope: "user",
    preferences: editedAccount,
  });
  await invoke("stable-detailed", "push.web.preferences.set", {
    scope: "device",
    preferences: { ...detailedDevice, label: "Renamed browser" },
  });
  await closeStateDatabaseForTest();
  await expectLegacyDetailed(editedAccount, "Renamed browser");

  const consent = { answerPreviewConsentVersion: 1, questionPreviewConsentVersion: 1 } as const;
  const consentedAccount = { ...editedAccount, ...consent };
  await invoke("stable-inherited", "push.web.preferences.set", {
    scope: "user",
    preferences: consentedAccount,
  });
  expect(await invoke("stable-inherited", "push.web.preferences.get")).toEqual({
    durableIdentity: true,
    user: consentedAccount,
    device: { enabled: true, label: "Inherited browser" },
    effective: { ...consentedAccount, enabled: true, label: "Inherited browser" },
  });
  // Existing explicit device choices do not acquire the new account consent.
  expect(await invoke("stable-detailed", "push.web.preferences.get")).toEqual({
    durableIdentity: true,
    user: consentedAccount,
    device: { ...detailedDevice, label: "Renamed browser" },
    effective: { ...editedAccount, enabled: true, label: "Renamed browser" },
  });
  const consentedDevice = { ...detailedDevice, label: "Renamed browser", ...consent };
  await invoke("stable-detailed", "push.web.preferences.set", {
    scope: "device",
    preferences: consentedDevice,
  });
  await closeStateDatabaseForTest();
  for (const [deviceId, device] of [
    ["stable-inherited", { enabled: true, label: "Inherited browser" }],
    ["stable-detailed", consentedDevice],
  ] as const) {
    expect(await invoke(deviceId, "push.web.preferences.get")).toEqual({
      durableIdentity: true,
      user: consentedAccount,
      device,
      effective: { ...consentedAccount, enabled: true, label: device.label },
    });
  }
});
