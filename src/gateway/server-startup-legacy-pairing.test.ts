import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.doctor.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runGatewayPostReadyStartupMaintenance } from "./server-startup-plugins.js";

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance: async () => {},
}));
// mock-isolation: Pairing-file admission must not repair the separate agent session stores.
vi.mock("./server-startup-session-migration.js", () => ({
  runGatewaySessionStartupMaintenance: async () => {},
}));

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
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
  state = await createOpenClawTestState({ label: "doctor-pairing-boundary" });
  stateDir = state.stateDir;
  const device = { publicKey: "pk", roles: ["node"], createdAtMs: 1, approvedAtMs: 1 };
  sources = new Map([
    ["devices/paired.json", JSON.stringify({ synthetic: device })],
    ["devices/pending.json", "{}"],
    ["devices/bootstrap.json", "{}"],
    ["nodes/paired.json", JSON.stringify({ synthetic: { caps: ["canvas"] } })],
    ["nodes/pending.json", "{}"],
  ]);
  for (const [relative, bytes] of sources) {
    await state.writeText(relative, bytes);
  }
  await state.writeConfig(cfg);
});

afterEach(async () => {
  try {
    await state?.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

it("leaves legacy pairing files for Doctor and reports the repair", async () => {
  await startup();
  await expectSources();
  expect(await getPairedDevice("synthetic", stateDir)).toBeNull();
  expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
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
it("retries failed imports in device-before-node order without repeating completed changes", async () => {
  await migrate(false);
  await expectSources();
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
  const result = await migrate();
  expect(result.warnings).toEqual([]);
  expect(await getPairedDevice("synthetic", stateDir)).toMatchObject({
    publicKey: "pk",
    roles: ["node"],
    nodeSurface: { caps: ["canvas"] },
  });
  expect((await listDevicePairing(stateDir)).pending).toEqual([]);
  await expectSources(".migrated");
  const repeated = await migrate();
  expect(repeated.changes).toEqual([]);
});
