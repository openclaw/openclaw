import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { migrateLegacyDesktopStreamOptOuts } from "../infra/device-pairing-node-desktop-migration.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { seedNodeDevice } from "../infra/device-pairing-node.test-support.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.doctor.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { runGatewayPostReadyStartupMaintenance } from "./server-startup-plugins.js";

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance: async () => {},
}));
// mock-isolation: Pairing-file admission must not repair the separate agent session stores.
vi.mock("./server-startup-session-migration.js", () => ({
  runGatewaySessionStartupMaintenance: async () => {},
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
let sources: Map<string, string>;
const cfg = { plugins: { enabled: false } };
const log = { info: vi.fn(), warn: vi.fn() };
const migrate = (doctorOnlyStateMigrations = true) =>
  autoMigrateLegacyState({
    cfg,
    env: process.env,
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    doctorOnlyStateMigrations,
  });
function startup() {
  return runGatewayPostReadyStartupMaintenance({
    getConfig: () => cfg,
    getPluginRegistry: createEmptyPluginRegistry,
    databases: [],
    signal: new AbortController().signal,
    log,
  });
}
async function expectSources(suffix = "") {
  for (const [relative, bytes] of sources) {
    expect(await fs.readFile(path.join(stateDir, relative) + suffix, "utf8")).toBe(bytes);
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  const home = temporary.make("openclaw-doctor-pairing-boundary-");
  stateDir = path.join(home, ".openclaw");
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  const device = { publicKey: "pk", roles: ["node"], createdAtMs: 1, approvedAtMs: 1 };
  sources = new Map([
    ["devices/paired.json", JSON.stringify({ synthetic: device })],
    ["devices/pending.json", "{}"],
    ["devices/bootstrap.json", "{}"],
    ["nodes/paired.json", JSON.stringify({ synthetic: { caps: ["canvas"] } })],
    ["nodes/pending.json", "{}"],
  ]);
  for (const [relative, bytes] of sources) {
    const file = path.join(stateDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(cfg));
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([false, true])("keeps legacy files and desktop opt-outs (desktop: %s)", async (desktop) => {
  if (desktop) {
    const callerScopes = ["operator.pairing", "operator.admin"];
    await seedNodeDevice(stateDir, "desktop-node");
    const { request } = await requestNodePairing(
      { nodeId: "desktop-node", platform: "darwin", commands: ["desktop.stream", "system.run"] },
      stateDir,
    );
    await approveNodePairing(request.requestId, { callerScopes }, stateDir);
  }
  const retired = await migrateLegacyDesktopStreamOptOuts(cfg, stateDir);
  await startup();
  if (desktop) {
    expect((await getPairedDevice("desktop-node", stateDir))?.nodeSurface?.commands).toEqual([
      "system.run",
    ]);
    expect(retired).toBe(1);
  } else {
    await expectSources();
    expect(await getPairedDevice("synthetic", stateDir)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
  }
});

it("reports pairing inspection failure without treating it as absence", async () => {
  const failure = Object.assign(new Error("synthetic EACCES"), { code: "EACCES" });
  const access = fs.access;
  const failedPath = path.join(stateDir, "devices/paired.json");
  vi.spyOn(fs, "access").mockImplementation((file, mode) =>
    String(file) === failedPath ? Promise.reject(failure) : access(file, mode),
  );
  await expect(startup()).resolves.toBeUndefined();
  expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(failure.message));
  await expect(migrate(false)).resolves.toBeDefined();
  const result = await migrate();
  expect(result.stepReceipts.find((receipt) => receipt.id === "migration-detection")).toMatchObject(
    { outcome: "refused" },
  );
  await expectSources();
});
it.each([false, true])("imports device approvals before node caps (retry: %s)", async (retry) => {
  if (retry) {
    const devicePath = path.join(stateDir, "devices/paired.json");
    await fs.writeFile(devicePath, "{invalid");
    const failed = await migrate();
    expect(failed.stepReceipts.find((receipt) => receipt.id === "pairing-stores")).toMatchObject({
      outcome: "refused",
    });
    expect(await fs.readFile(devicePath, "utf8")).toBe("{invalid");
    expect(await fs.readFile(path.join(stateDir, "nodes/paired.json"), "utf8")).toBe(
      sources.get("nodes/paired.json"),
    );
    await fs.writeFile(devicePath, sources.get("devices/paired.json")!);
  } else {
    await migrate(false);
    await expectSources();
  }
  const result = await migrate();
  expect(result.warnings).toEqual([]);
  expect(await getPairedDevice("synthetic", stateDir)).toMatchObject({
    publicKey: "pk",
    roles: ["node"],
    nodeSurface: { caps: ["canvas"] },
  });
  expect((await listDevicePairing(stateDir)).pending).toEqual([]);
  await expectSources(".migrated");
  if (!retry) {
    const repeated = await migrate();
    expect(repeated.changes).toEqual([]);
  }
});
