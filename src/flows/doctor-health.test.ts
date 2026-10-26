import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStateOwnerPath } from "../infra/gateway-state-owner.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "../infra/state-migrations.workspace-setup.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION as SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { useDoctorHealthFixture } from "./doctor-health.fixture.test-support.js";
import { runDoctorHealthFlow } from "./doctor-health.js";
import * as support from "./doctor-health.test-support.js";

const { mocks, registerDoctorConfigReceiptTests } = support;
const repairOptions = { repair: true, nonInteractive: true };
const leaseRefusal =
  "Doctor could not enter maintenance. An agent database is in use. Stop the Gateway and other OpenClaw processes or reboot, then rerun openclaw doctor --fix.";

function expectNotCalled(...spies: { mock: { calls: unknown[][] } }[]) {
  spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
}

vi.mock("../commands/doctor-update-refusal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/doctor-update-refusal.js")>()),
  // Git recovery has its own refusal tests; service admission must not inspect the host checkout.
  resolveUpdateDoctorGitRecovery: async () => undefined,
}));

const { openHistoricalAgentDatabase } = useDoctorHealthFixture();

it.each(["unresolved-unknown", "windows-queued", "windows-startup-unknown", "split-root-bun"])(
  "repairs only with settled service authority: %s",
  async (kind) => {
    const split = kind === "split-root-bun";
    const windows = kind.startsWith("windows");
    support.stubDoctorEnv(
      split
        ? {
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: undefined,
          }
        : buildUpdateDoctorEnv({ allowGatewayServiceRepair: true, allowGatewayActivation: false }),
    );
    mocks.servicePlatform = windows ? "win32" : undefined;
    await support.withDoctorState(async (state) => {
      const resultPath = state.path("doctor-result.json");
      vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", split ? undefined : resultPath);
      const cfg: OpenClawConfig = split
        ? {}
        : {
            agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
          };
      await state.writeConfig(cfg);
      fs.mkdirSync(state.workspaceDir, { recursive: true });
      const sourcePath = path.join(state.workspaceDir, "openclaw-workspace-state.json");
      const completedAt = "2026-07-15T00:00:00.000Z";
      fs.writeFileSync(sourcePath, JSON.stringify({ version: 1, setupCompletedAt: completedAt }));
      const persistedPaths = [sourcePath, state.configPath];
      const before = persistedPaths.map((file) => fs.readFileSync(file));
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      const ownerPath = resolveGatewayStateOwnerPath(databasePath);
      const serviceRoot = state.path("service-install");
      const activeRoot = split ? state.path("cli-install") : process.cwd();
      for (const root of split ? [activeRoot, serviceRoot] : windows ? [serviceRoot] : []) {
        fs.mkdirSync(root);
        fs.writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", ...(split ? { version: "2026.9.6" } : {}) }),
        );
      }
      let running = split;
      const install = vi.fn();
      const service = {
        readCommand: async () => ({
          ...(windows ? { sourcePath: state.path("foreign-state", "gateway.cmd") } : {}),
          programArguments: [
            split ? state.path("runtime", "bun") : process.execPath,
            windows || split ? path.join(serviceRoot, "openclaw.mjs") : "operator-wrapper",
            "gateway",
          ],
          environment: {
            OPENCLAW_STATE_DIR: windows ? state.path("foreign-state") : state.stateDir,
            OPENCLAW_CONFIG_PATH: windows ? state.path("foreign.json") : state.configPath,
          },
        }),
        readRuntime: async () => ({
          status: running ? "running" : windows || split ? "stopped" : "unknown",
          ...(running ? { pid: 4200 } : {}),
          systemd: { managerUid: process.getuid?.() ?? 2001 },
        }),
        isLoaded: async () => windows || split,
        stop: vi.fn(async () => {
          running = false;
        }),
        restart: vi.fn(),
        ...(split ? { install } : { isEnabled: async () => true }),
      };
      mocks.packageRoot.mockReturnValue(activeRoot);
      mocks.config.mockClear().mockReturnValue(cfg);
      mocks.service.mockReturnValue(service);
      mocks.taskDefinitelyStopped.mockReturnValue(!windows);
      mocks.resident.mockImplementation(() => (running ? { pid: 4200 } : undefined));
      if (kind === "windows-startup-unknown") {
        mocks.startupFallbackRuntime.mockRejectedValue(
          new Error("synthetic task inspection failure"),
        );
      }
      if (!split) {
        mocks.runContributions.mockImplementation(async (ctx) => {
          const scope = { stateDir: state.stateDir, env: state.env };
          const detected = await detectLegacyWorkspaceState({
            ...scope,
            cfg: ctx.cfg,
            homedir: () => state.home,
            doctorOnlyStateMigrations: true,
          });
          const result = await migrateLegacyWorkspaceState({ ...scope, detected });
          expect(result.warnings).toEqual([]);
        });
      }
      const runtime = support.createDoctorRuntime();
      const run = runDoctorHealthFlow(runtime, repairOptions);
      if (windows || split) {
        await expect(run).rejects.toThrow(
          split ? "different OpenClaw installation" : "Doctor could not enter maintenance",
        );
        expect(persistedPaths.map((file) => fs.readFileSync(file))).toEqual(before);
        expect([databasePath, ownerPath].some((file) => fs.existsSync(file))).toBe(false);
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
        if (split) {
          expectNotCalled(install, mocks.runContributions);
          expect(await service.readRuntime()).toMatchObject({ status: "running", pid: 4200 });
        } else {
          await expect(run).rejects.toThrow("gateway status --deep");
          await expect(run).rejects.toThrow("openclaw doctor --fix");
          await expect(run).rejects.not.toThrow(/--no-restart|before the update/);
          expectNotCalled(mocks.config, mocks.runContributions);
        }
      } else {
        await run;
        expect((await readWorkspaceStateSnapshot(state.workspaceDir)).setup.setupCompletedAt).toBe(
          completedAt,
        );
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
        const action = "Stop the Gateway through its owner";
        expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(action));
        expect(mocks.writeUpdatePostInstallDoctorResult.mock.lastCall?.[0]).toMatchObject({
          resultPath,
          result: {
            status: "ok",
            warnings: expect.arrayContaining([expect.stringContaining(action)]),
          },
        });
      }
      expectNotCalled(service.stop, service.restart);
    });
  },
);

registerDoctorConfigReceiptTests(runDoctorHealthFlow);

it("refuses blocked required migration, then completes after the writer releases", async () => {
  const options = { yes: true, nonInteractive: true };
  await support.withDoctorState(async (state) => {
    const { env } = state;
    const initial = openHistoricalAgentDatabase({ agentId: "main", env });
    initial.db.close();
    closeOpenClawAgentDatabasesForTest();
    const before = fs.readFileSync(initial.path);
    const leaseId = claimOpenClawAgentDatabaseLease({ agentId: "main", path: initial.path, env });
    const maintenanceOutcome = support.seedMaintenanceStartupFailure(() =>
      openOpenClawStateDatabase({ env }),
    );
    const runtime = support.createDoctorRuntime();
    mocks.runContributions.mockImplementation(async () => {
      await migrateLegacyMediaPersistence();
    });
    try {
      await runDoctorHealthFlow(runtime, { nonInteractive: true });
      expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
      mocks.outro.mockClear();
      vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", state.path("advisory.json"));
      await runCommandWithRuntime(runtime, () => runDoctorHealthFlow(runtime, options));
      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(runtime.error).toHaveBeenCalledWith(leaseRefusal);
      expect(maintenanceOutcome()).toEqual({ outcome: "startup_failed" });
      expect(
        mocks.writeUpdatePostInstallDoctorResult.mock.lastCall?.[0].result.failureFacts,
      ).toEqual([{ check: "doctor", code: "agent-database-lease-active", message: leaseRefusal }]);
      expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
      expect(fs.readFileSync(initial.path)).toEqual(before);
      const { db } = openOpenClawStateDatabase({ env });
      expect(
        db.prepare("SELECT lease_id FROM agent_database_leases WHERE lease_id = ?").get(leaseId),
      ).toEqual({ lease_id: leaseId });
    } finally {
      vi.unstubAllEnvs();
      releaseOpenClawAgentDatabaseLease(leaseId, { env });
    }
    runtime.exit.mockClear();
    await runDoctorHealthFlow(runtime, options);
    expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
    const { db } = openOpenClawAgentDatabase({ agentId: "main", env });
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_VERSION);
    const metadata = db.prepare("SELECT schema_version FROM schema_meta").get();
    expect(metadata?.schema_version).toBe(SCHEMA_VERSION);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(maintenanceOutcome()).toEqual({ outcome: "startup_failure_repaired" });
  });
});
