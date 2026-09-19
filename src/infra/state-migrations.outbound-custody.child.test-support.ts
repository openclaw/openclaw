import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { PluginRuntimeCloseRetainedError } from "../plugins/runtime-close-error.js";
import { seedDeliveryQueueEntry } from "./delivery-queue-sqlite.test-support.js";
import { tryAcquireExclusiveSqliteCoordinator } from "./sqlite-coordinator.js";
import { acquireGatewayLifecycleCoordinator } from "./state-database-coordinator.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";

const [stateDir, mode] = process.argv.slice(2);
if (
  !stateDir ||
  !mode ||
  !["success", "callback-failure", "retained-release", "retained-acquire"].includes(mode)
) {
  throw new Error("Expected isolated state directory and custody case");
}
const pluginDir = path.join(stateDir, "plugin");
await fs.mkdir(pluginDir, { recursive: true });
const nativeState: { native?: DatabaseSync; failure: Error; nativePath: string } = {
  failure: new PluginRuntimeCloseRetainedError(new Error("synthetic native resource retained")),
  nativePath: path.join(stateDir, "native.sqlite"),
};
Object.defineProperty(globalThis, "__doctorCustodyFixture", { value: nativeState });
await fs.writeFile(
  path.join(pluginDir, "openclaw.plugin.json"),
  JSON.stringify({
    id: "doctor-custody-fixture",
    channels: ["matrix"],
    configSchema: { type: "object" },
  }),
);
const pluginFile = path.join(pluginDir, "index.cjs");
await fs.writeFile(
  pluginFile,
  `module.exports = { id: "doctor-custody-fixture", register(api) {
  const state = globalThis.__doctorCustodyFixture;
  state.native = new (require("node:sqlite").DatabaseSync)(state.nativePath);
  state.native.exec("CREATE TABLE effects (value TEXT)");
  api.registerRuntimeLifecycle({ id: "native-custody", dispose() {
    if (${JSON.stringify(mode)}.startsWith("retained")) throw state.failure;
    state.native.close();
    if (${JSON.stringify(mode)} === "callback-failure") throw new Error("settled callback failure");
  } });
  if (${JSON.stringify(mode)} === "retained-acquire") throw new Error("registration failed after resource acquisition");
  api.on("message_sending", (event) => ({ content: event.content + "|prepared" }));
  api.registerChannel({ plugin: {
    id: "matrix", meta: { id: "matrix", label: "Fixture", selectionLabel: "Fixture", docsPath: "/fixture", blurb: "Synthetic" },
    capabilities: { chatTypes: ["direct"] }, config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
    outbound: { deliveryMode: "direct", sendText: async () => { throw new Error("unexpected send"); } },
  } });
} };`,
);
const cfg = {
  plugins: {
    allow: ["doctor-custody-fixture"],
    entries: { "doctor-custody-fixture": { enabled: true } },
    load: { paths: [pluginFile] },
    slots: { memory: "none" },
  },
  channels: { matrix: { enabled: true } },
};
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(cfg));
const entry = {
  id: "custody",
  enqueuedAt: Date.now(),
  retryCount: 0,
  attemptCount: 0,
  channel: "matrix",
  to: "!synthetic:example",
  payloads: [{ text: "synthetic" }],
};
seedDeliveryQueueEntry({ queueName: "outbound", entry, stateDir });
const coordinator = acquireGatewayLifecycleCoordinator({
  databasePath: path.join(stateDir, "state/openclaw.sqlite"),
});
const coordinatorPath = coordinator.path;
coordinator.release();
const maintenance = await beginDoctorMaintenance({
  options: { repair: true, nonInteractive: true },
  root: null,
  runtime: { log() {}, error() {}, exit() {} },
});
if (!maintenance) {
  throw new Error("Expected Doctor maintenance");
}
const result = await maintenance.run(() =>
  autoMigrateLegacyState({
    cfg,
    env: process.env,
    doctorOnlyStateMigrations: true,
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  }),
);
await maintenance.release();
const writable = nativeState.native?.isOpen === true;
if (nativeState.native?.isOpen) {
  nativeState.native.exec("INSERT INTO effects VALUES ('after failed cleanup')");
}
// A fresh native connection bypasses the reentrant coordinator map, like another process.
const competitor = tryAcquireExclusiveSqliteCoordinator(coordinatorPath, { busyTimeoutMs: 0 });
const blocked = competitor === null;
competitor?.release();
if (nativeState.native?.isOpen) {
  nativeState.native.close();
}
const receipt = result.stepReceipts.find((item) => item.id === "delivery-queues");
process.stdout.write(
  JSON.stringify({ blocked, writable, outcome: receipt?.outcome }) + "\n",
  () => {
    // A retained inspection has no retryable release handle; ending its owner releases OS custody.
    process.exit(0);
  },
);
