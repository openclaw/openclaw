import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import type { GatewayService } from "../daemon/service.js";
import { createMockGatewayService, mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { useDoctorMaintenanceRuntimeDirectory } from "./doctor-maintenance.test-support.js";
import { repairAuthProfileMigration } from "./doctor/auth-profile-repair.js";

const mocks = vi.hoisted(() => ({ service: undefined as GatewayService | undefined }));
function assertServiceUnchanged() {
  for (const operation of ["stage", "stop", "start", "restart", "install", "uninstall"] as const) {
    expect(mocks.service![operation]).not.toHaveBeenCalled();
  }
}
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
afterEach(() => vi.restoreAllMocks());

it.each([
  ["CLI service", false, false, "linux"],
  ["offline app-owned service", true, false, undefined],
  ["running app-owned service", true, true, undefined],
  ["running app-owned service on Linux", true, true, "linux"],
] as const)(
  "repairs canonical state without mutating the %s",
  async (_name, appOwned, running, platform) => {
    if (platform) {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    }
    await withOpenClawTestState(
      {
        env: {
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_SUPERVISOR_MODE: undefined,
          OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
          OPENCLAW_UPDATE_IN_PROGRESS: undefined,
          OPENCLAW_UPDATE_RUN_ID: undefined,
        },
      },
      async (state) => {
        state.envVars.OPENCLAW_HOME = undefined;
        state.applyEnv();
        const { home } = state;
        const agentDir = state.agentDir();
        const profile = { type: "api_key", provider: "claude-cli", key: "fixture-credential" };
        const source = JSON.stringify({ version: 1, profiles: { "claude-cli:default": profile } });
        const sourcePath = await state.writeText("agents/main/agent/auth-profiles.json", source);
        mockSystemAccountHome();
        expect(isDefaultInstallIdentity()).toBe(true);
        let serviceRoot = process.cwd();
        if (appOwned) {
          serviceRoot = tempDirs.make("doctor-app-owned-runtime-");
          fs.writeFileSync(path.join(serviceRoot, "package.json"), '{"name":"openclaw"}');
          fs.writeFileSync(
            path.join(serviceRoot, "openclaw-install-owner.json"),
            '{"schemaVersion":1,"owner":"macos-app","displayName":"OpenClaw.app","updateHint":"Update OpenClaw.app to update this Gateway."}',
          );
          fs.writeFileSync(path.join(serviceRoot, "openclaw.mjs"), "");
        }
        mocks.service = createMockGatewayService({
          isLoaded: vi.fn(async () => !appOwned || running),
          readRuntime: vi.fn(async () => ({
            status: running ? "running" : "stopped",
            // App payload ownership requires native manager identity; the CLI control stays unverified.
            ...(appOwned ? { systemd: { managerUid: process.getuid?.() ?? 501 } } : {}),
          })),
          readCommand: vi.fn(async () => ({
            programArguments: [process.execPath, path.join(serviceRoot, "openclaw.mjs"), "gateway"],
            environment: { HOME: home, OPENCLAW_HOME: home },
          })),
        });
        const pending = beginDoctorMaintenance({
          root: process.cwd(),
          options: { repair: true, nonInteractive: true },
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        });
        if (running) {
          await expect(pending).rejects.toThrow("Managed by OpenClaw.app");
          expect(fs.readFileSync(sourcePath, "utf8")).toBe(source);
          assertServiceUnchanged();
          return;
        }
        const maintenance = await pending;
        try {
          const repaired = await maintenance!.run(() =>
            repairAuthProfileMigration({
              cfg: { agents: { ownership: "explicit", entries: { main: {} } } },
              prompter: { shouldRepair: true, confirmAutoFix: async () => true },
            }),
          );
          expect(repaired.warnings).toEqual([]);
          expect(maintenance!.run(() => loadPersistedAuthProfileStore(agentDir))).toMatchObject({
            profiles: { "anthropic:default": { ...profile, provider: "anthropic" } },
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
        assertServiceUnchanged();
      },
    );
  },
);
