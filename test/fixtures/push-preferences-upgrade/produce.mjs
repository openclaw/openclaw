import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const releaseRoot = path.resolve(process.argv[2]);
const stateDir = path.resolve(process.argv[3]);
const released = (name) => import(pathToFileURL(path.join(releaseRoot, "dist", name)).href);
assert.equal(fs.existsSync(stateDir), false, "producer requires fresh isolated state");
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
const { n: ensureProfileForEmail } = await released("user-profiles-BoCmKKKs.mjs");
const { pushHandlers } = await released("push-BOtYInjQ.mjs");
const { closeOpenClawStateDatabaseAsync } = await released("openclaw-state-db-C0iTj_4a.mjs");

const profile = ensureProfileForEmail("stable-notification-owner@example.test");
const defaultProfile = ensureProfileForEmail("stable-default-owner@example.test");
const devices = [
  { id: "stable-inherited", profileId: profile.id },
  { id: "stable-detailed", profileId: profile.id },
  { id: "stable-default", profileId: defaultProfile.id },
];
const userPreferences = {
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
};

async function invoke(device, method, params) {
  let response;
  await pushHandlers[method]({
    req: { type: "req", id: "stable-producer", method },
    params,
    client: {
      connId: device.id,
      connect: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "openclaw-control-ui",
          version: "2026.10.2",
          platform: "web",
          mode: "webchat",
        },
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        device: {
          id: device.id,
          publicKey: "synthetic",
          signature: "synthetic",
          signedAt: 1,
          nonce: "synthetic",
        },
      },
      authenticatedUserProfile: {
        profileId: device.profileId,
        displayName: null,
        hasAvatar: false,
        updatedAt: 1,
      },
    },
    respond: (ok, payload, error) => {
      assert.equal(ok, true, JSON.stringify(error));
      response = payload;
    },
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => ({}),
      broadcastToConnIds: () => {},
      getClientConnIds: () => new Set(),
    },
  });
  assert.ok(response, `${method} must respond`);
  return response;
}

for (const device of devices) {
  const endpoint = `https://push.example.test/${device.id}`;
  await invoke(device, "push.web.subscribe", {
    endpoint,
    keys: { p256dh: "synthetic-p256dh", auth: "synthetic-auth" },
  });
  if (device.id === "stable-inherited") {
    await invoke(device, "push.web.preferences.set", {
      endpoint,
      scope: "user",
      preferences: userPreferences,
    });
    await invoke(device, "push.web.preferences.set", {
      endpoint,
      scope: "device",
      preferences: { enabled: true, label: "Inherited browser" },
    });
  }
  if (device.id === "stable-detailed") {
    await invoke(device, "push.web.preferences.set", {
      endpoint,
      scope: "device",
      preferences: {
        enabled: true,
        label: "Detailed browser",
        detailLevel: "detailed",
        categories: { agentFinished: true, agentQuestion: true },
      },
    });
  }
}
const preferences = [];
for (const device of devices) {
  preferences.push({
    deviceId: device.id,
    ...(await invoke(device, "push.web.preferences.get", {
      endpoint: `https://push.example.test/${device.id}`,
    })),
  });
}
await closeOpenClawStateDatabaseAsync();
const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
const database = new DatabaseSync(databasePath, { readOnly: true });
const schemaVersion = database.prepare("PRAGMA user_version").get();
const preferenceRows = database
  .prepare(
    "SELECT profile_id, pref_key, value_json FROM user_preferences ORDER BY profile_id, pref_key",
  )
  .all();
const subscriptionRows = database
  .prepare(
    "SELECT endpoint, device_id, user_profile_id, preferences_json FROM web_push_subscriptions ORDER BY device_id",
  )
  .all();
assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
database.close();
const result = {
  release: "2026.10.2",
  profileId: profile.id,
  defaultProfileId: defaultProfile.id,
  databasePath,
  schemaVersion,
  preferences,
  preferenceRows,
  subscriptionRows,
};
assert.equal(schemaVersion.user_version, 20);
const dump = execFileSync("sqlite3", [databasePath, ".dump"], { encoding: "utf8" });
fs.writeFileSync(
  path.join(root, "openclaw-2026.10.2.sql"),
  `-- Produced by OpenClaw 2026.10.2 production push handlers; see README.md.\nPRAGMA user_version=20;\n${dump}`,
);
console.log(JSON.stringify(result, null, 2));
