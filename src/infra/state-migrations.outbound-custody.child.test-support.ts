import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import { migrateDoctorDeliveryQueues } from "../commands/doctor-outbound-delivery.js";
import { PluginLoadFailureError } from "../plugins/loader-shared.js";
import { PluginRuntimeCloseRetainedError } from "../plugins/runtime-close-error.js";
import { seedDeliveryQueueEntry } from "./delivery-queue-sqlite.test-support.js";
import { tryAcquireGatewayStateOwner } from "./gateway-state-owner.js";

const modes = ["success", "callback-failure", "retained-release", "retained-acquire"] as const;
type Mode = (typeof modes)[number];

async function runMode(stateDir: string, mode: Mode) {
  process.stderr.write(`Doctor custody case: ${mode}\n`);
  process.env.HOME = stateDir;
  process.env.USERPROFILE = stateDir;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  process.env.OPENCLAW_HOME = stateDir;

  const pluginId = `doctor-custody-fixture-${mode}`;
  const pluginDir = path.join(stateDir, "plugin");
  await fs.mkdir(pluginDir, { recursive: true });
  const nativeState: {
    native?: DatabaseSync;
    failure: Error;
    callbackFailure: Error;
    nativePath: string;
  } = {
    failure: new PluginRuntimeCloseRetainedError(new Error("synthetic native resource retained")),
    callbackFailure: new Error("settled callback failure"),
    nativePath: path.join(stateDir, "native.sqlite"),
  };
  Object.defineProperty(globalThis, "__doctorCustodyFixture", {
    configurable: true,
    value: nativeState,
  });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({ id: pluginId, channels: ["matrix"], configSchema: { type: "object" } }),
  );
  const pluginFile = path.join(pluginDir, "index.cjs");
  await fs.writeFile(
    pluginFile,
    `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
  const state = globalThis.__doctorCustodyFixture;
  state.native = new (require("node:sqlite").DatabaseSync)(state.nativePath);
  state.native.exec("CREATE TABLE effects (value TEXT)");
  api.registerRuntimeLifecycle({ id: "native-custody", dispose() {
    if (${JSON.stringify(mode)}.startsWith("retained")) throw state.failure;
    state.native.close();
    if (${JSON.stringify(mode)} === "callback-failure") throw state.callbackFailure;
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
      allow: [pluginId],
      entries: { [pluginId]: { enabled: true } },
      load: { paths: [pluginFile] },
      slots: { memory: "none" },
    },
    channels: { matrix: { enabled: true } },
  };
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
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
  const databasePath = path.join(stateDir, "state/openclaw.sqlite");
  const maintenance = await beginDoctorMaintenance({
    options: { repair: true, nonInteractive: true },
    root: null,
    runtime: { log() {}, error() {}, exit() {} },
  });
  if (!maintenance) {
    throw new Error("Expected Doctor maintenance");
  }
  let failure: unknown;
  try {
    await maintenance.run(() => migrateDoctorDeliveryQueues({ cfg, stateDir, env: process.env }));
  } catch (error) {
    failure = error;
  } finally {
    await maintenance.release();
  }
  const writable = nativeState.native?.isOpen === true;
  if (nativeState.native?.isOpen) {
    nativeState.native.exec("INSERT INTO effects VALUES ('after failed cleanup')");
  }
  // A fresh process-owner acquisition cannot borrow retained maintenance authority.
  const competitor = tryAcquireGatewayStateOwner(databasePath);
  const blocked = competitor === null;
  competitor?.release();
  if (nativeState.native?.isOpen) {
    nativeState.native.close();
  }
  const errors = collectNestedErrorCandidates(failure);
  const acquisitionFailure = errors.find((error) => error instanceof PluginLoadFailureError);
  return {
    mode,
    blocked,
    writable,
    registered: nativeState.native !== undefined,
    failed: failure !== undefined,
    callbackFailure: errors.includes(nativeState.callbackFailure),
    retainedFailure: errors.includes(nativeState.failure),
    acquisitionFailure: acquisitionFailure
      ? { pluginIds: acquisitionFailure.pluginIds, message: acquisitionFailure.message }
      : null,
  };
}

const [stateRoot, requestedMode] = process.argv.slice(2);
if (
  !stateRoot ||
  !requestedMode ||
  (requestedMode !== "all" && !modes.includes(requestedMode as Mode))
) {
  throw new Error("Expected isolated state directory and custody case");
}
const selectedModes = requestedMode === "all" ? modes : [requestedMode as Mode];
const reports = [];
for (const mode of selectedModes) {
  reports.push(
    await runMode(requestedMode === "all" ? path.join(stateRoot, mode) : stateRoot, mode),
  );
}
process.stdout.write(JSON.stringify(requestedMode === "all" ? reports : reports[0]) + "\n", () => {
  // A retained inspection has no retryable release handle; ending its owner releases OS custody.
  process.exit(0);
});
