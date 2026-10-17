import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const doctorParams = () => ({
  cfg,
  env: process.env,
  legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
});
const migrate = () =>
  autoMigrateLegacyState({ ...doctorParams(), doctorOnlyStateMigrations: true });
function startup() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log,
    run: () =>
      runGatewayPostReadyStartupMaintenance({
        getConfig: () => cfg,
        getPluginRegistry: createEmptyPluginRegistry,
        databases: [],
        signal: new AbortController().signal,
        log,
      }),
  };
}
async function expectSources(suffix = "") {
  for (const [relative, bytes] of sources) {
    expect(await fs.readFile(path.join(stateDir, relative) + suffix, "utf8")).toBe(bytes);
  }
}

beforeEach(async () => {
  const home = temporary.make("openclaw-doctor-pairing-boundary-");
  stateDir = path.join(home, ".openclaw");
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  sources = new Map([
    [
      "devices/paired.json",
      JSON.stringify({
        synthetic: {
          deviceId: "synthetic",
          publicKey: "synthetic-public-key",
          role: "node",
          roles: ["node"],
          scopes: [],
          approvedScopes: [],
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      }),
    ],
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

describe("legacy pairing repair ownership", () => {
  it.each([false, true])(
    "preserves legacy approvals and disabled desktop grants at startup (desktop: %s)",
    async (desktop) => {
      if (desktop) {
        await seedNodeDevice(stateDir, "desktop-node");
        const { request } = await requestNodePairing(
          {
            nodeId: "desktop-node",
            platform: "darwin",
            commands: ["desktop.stream", "system.run"],
          },
          stateDir,
        );
        await approveNodePairing(
          request.requestId,
          { callerScopes: ["operator.pairing", "operator.admin"] },
          stateDir,
        );
      }
      const { run, log } = startup();
      const retired = await migrateLegacyDesktopStreamOptOuts(cfg, stateDir);
      await run();
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
    },
  );

  it("reports pairing inspection failure without treating it as absence", async () => {
    const code = "EACCES";
    const access = fs.access;
    const failedPath = path.join(stateDir, "devices/paired.json");
    vi.spyOn(fs, "access").mockImplementation((file, mode) =>
      String(file) === failedPath
        ? Promise.reject(Object.assign(new Error(`synthetic ${code}`), { code }))
        : access(file, mode),
    );
    const { run, log } = startup();
    await expect(run()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`synthetic ${code}`));
    await expect(autoMigrateLegacyState(doctorParams())).resolves.toBeDefined();
    const result = await migrate();
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "migration-detection"),
    ).toMatchObject({ outcome: "refused" });
    await expectSources();
  });
  it.each([false, true])(
    "imports device approvals before node capabilities in Doctor (failed first attempt: %s)",
    async (retry) => {
      if (retry) {
        const devicePath = path.join(stateDir, "devices/paired.json");
        await fs.writeFile(devicePath, "{invalid");
        const failed = await migrate();
        expect(
          failed.stepReceipts.find((receipt) => receipt.id === "pairing-stores"),
        ).toMatchObject({ outcome: "refused" });
        expect(await fs.readFile(devicePath, "utf8")).toBe("{invalid");
        expect(await fs.readFile(path.join(stateDir, "nodes/paired.json"), "utf8")).toBe(
          sources.get("nodes/paired.json"),
        );
        await fs.writeFile(devicePath, sources.get("devices/paired.json")!);
      } else {
        await autoMigrateLegacyState(doctorParams());
        await expectSources();
      }
      const result = await migrate();
      expect(result.warnings).toEqual([]);
      expect(await getPairedDevice("synthetic", stateDir)).toMatchObject({
        publicKey: "synthetic-public-key",
        roles: ["node"],
        nodeSurface: { caps: ["canvas"] },
      });
      expect((await listDevicePairing(stateDir)).pending).toEqual([]);
      await expectSources(".migrated");
      if (!retry) {
        const repeated = await migrate();
        expect(repeated.changes).toEqual([]);
      }
    },
  );
});
