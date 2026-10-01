import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import type { GatewayService } from "../daemon/service.js";
import { createMockGatewayService, mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { useDoctorMaintenanceRuntimeDirectory } from "./doctor-maintenance.test-support.js";
import { repairAuthProfileMigration } from "./doctor/auth-profile-repair.js";

const mocks = vi.hoisted(() => ({ service: undefined as GatewayService | undefined }));
vi.mock("../daemon/service.js", async (original) => ({
  ...(await original<typeof import("../daemon/service.js")>()),
  resolveGatewayService: () => mocks.service!,
}));
vi.mock("./doctor-service-repair-policy.js", async (original) => ({
  ...(await original<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
useDoctorMaintenanceRuntimeDirectory(() => tempDirs.make("doctor-service-identity-runtime-"));
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "repairs credentials with a canonical service OPENCLAW_HOME only when state is offline (active writer: %s)",
  async (activeWriter) => {
    const home = tempDirs.make("doctor-service-identity-");
    const stateDir = path.join(home, ".openclaw");
    const agentDir = path.join(stateDir, "agents/main/agent");
    const sourcePath = path.join(agentDir, "auth-profiles.json");
    const profile = { type: "api_key", provider: "claude-cli", key: "fixture-credential" };
    const source = JSON.stringify({ version: 1, profiles: { "claude-cli:default": profile } });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(sourcePath, source);
    for (const [key, value] of Object.entries({
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_HOME: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
      OPENCLAW_UPDATE_IN_PROGRESS: undefined,
      OPENCLAW_UPDATE_RUN_ID: undefined,
    })) {
      vi.stubEnv(key, value);
    }
    mockSystemAccountHome();
    expect(isDefaultInstallIdentity()).toBe(true);
    mocks.service = createMockGatewayService({
      isLoaded: vi.fn(async () => true),
      readCommand: vi.fn(async () => ({
        programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
        environment: { HOME: home, OPENCLAW_HOME: home },
      })),
    });
    const owner = activeWriter
      ? acquireGatewayStateOwner({ databasePath: path.join(stateDir, "state/openclaw.sqlite") })
      : undefined;
    try {
      const begin = () =>
        beginDoctorMaintenance({
          root: process.cwd(),
          options: { repair: true, nonInteractive: true },
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        });
      if (activeWriter) {
        await expect(begin()).rejects.toThrow("is undergoing offline maintenance");
        expect(fs.readFileSync(sourcePath, "utf8")).toBe(source);
      } else {
        const maintenance = await begin();
        expect(maintenance).toBeDefined();
        try {
          const repaired = await maintenance!.run(() =>
            repairAuthProfileMigration({
              cfg: { agents: { ownership: "explicit", entries: { main: {} } } },
              prompter: { shouldRepair: true, confirmAutoFix: async () => true },
            }),
          );
          expect(repaired.warnings).toEqual([]);
          expect(maintenance!.run(() => loadPersistedAuthProfileStore(agentDir))).toMatchObject({
            profiles: {
              "anthropic:default": {
                type: "api_key",
                provider: "anthropic",
                key: "fixture-credential",
              },
            },
          });
          expect(fs.existsSync(sourcePath)).toBe(false);
          const archives = fs
            .readdirSync(agentDir)
            .filter((name) => name.startsWith("auth-profiles.json.migrated-"));
          expect(archives).toHaveLength(1);
          expect(fs.readFileSync(path.join(agentDir, archives[0]!), "utf8")).toBe(source);
          await maintenance!.finish(repaired.config);
        } finally {
          await maintenance!.release();
        }
      }
      for (const operation of ["stop", "start", "restart", "install", "uninstall"] as const) {
        expect(mocks.service[operation]).not.toHaveBeenCalled();
      }
    } finally {
      owner?.release();
    }
  },
);
