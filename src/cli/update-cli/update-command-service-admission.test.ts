import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { ServiceInspectionError } from "../../daemon/service-inspection-error.js";
import * as service from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import {
  loadUpdateRecovery,
  UpdateRecoveryRequiredError,
} from "../../infra/update-run-recovery.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import * as shared from "./shared.js";
import {
  admitUpdateCommandRun,
  prepareUpdateCommand,
  resolveUpdateCommandAdmissionEnv,
} from "./update-command-run.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";
import { GatewayServiceUpdateOwnershipError } from "./update-command-service-plan.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each(
  (["linux", "darwin"] as const).flatMap((platform) =>
    (["unavailable", "conflict", "pending", "redirect"] as const).map((outcome) => ({
      platform,
      outcome,
    })),
  ),
)("preserves service admission authority ($platform, $outcome)", async ({ platform, outcome }) => {
  const home = dirs.make("update-service-admission-");
  const callerRoot = path.join(home, "caller-package");
  const serviceRoot = path.join(home, "service-package");
  const callerState = path.join(home, ".openclaw-caller");
  const serviceState = path.join(home, ".openclaw-service");
  await Promise.all([
    writePackageRoot(callerRoot, "1.0.0"),
    writePackageRoot(serviceRoot, "1.0.0"),
  ]);
  await withEnvAsync(
    {
      HOME: home,
      OPENCLAW_HOME: undefined,
      OPENCLAW_PROFILE: "caller",
      OPENCLAW_STATE_DIR: callerState,
      OPENCLAW_CONFIG_PATH: path.join(callerState, "openclaw.json"),
      OPENCLAW_SYSTEMD_UNIT: undefined,
      OPENCLAW_LAUNCHD_LABEL: undefined,
      OPENCLAW_WINDOWS_TASK_NAME: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_UPDATE_POST_CORE: undefined,
    },
    async () => {
      mockProcessPlatform(platform);
      mockSystemAccountHome();
      vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(callerRoot);
      const native = createMockGatewayService({
        isLoaded: async () => {
          if (outcome === "unavailable") {
            throw new ServiceInspectionError("service-manager-unavailable");
          }
          return true;
        },
        readRuntime: async () =>
          outcome === "unavailable"
            ? { status: "unknown", inspectionReason: "service-manager-unavailable" }
            : { status: "running", systemd: { managerUid: 2001 } },
        readCommand: async () => ({
          programArguments: [
            process.execPath,
            path.join(serviceRoot, "dist", "index.js"),
            "gateway",
          ],
          environment: {
            OPENCLAW_PROFILE: "service",
            OPENCLAW_STATE_DIR: serviceState,
            OPENCLAW_CONFIG_PATH: path.join(serviceState, "openclaw.json"),
            ...(outcome === "conflict"
              ? platform === "linux"
                ? { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-other.service" }
                : { OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.other" }
              : {}),
          },
        }),
      });
      vi.spyOn(service, "resolveGatewayService").mockReturnValue(native);
      if (outcome === "conflict") {
        await expect(prepareUpdateCommand({ dryRun: true })).rejects.toBeInstanceOf(
          GatewayServiceUpdateOwnershipError,
        );
        await expect(fs.stat(callerState)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(serviceState)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      const prepared = await prepareUpdateCommand({ dryRun: true });
      const root = prepared.servicePlan?.rootRedirect?.root ?? prepared.discoveredRoot;
      const env = await resolveUpdateCommandAdmissionEnv({ root, opts: {} });
      expect(root).toBe(callerRoot);
      expect(env.OPENCLAW_STATE_DIR).toBe(outcome === "unavailable" ? callerState : serviceState);
      if (outcome === "pending") {
        const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
        const from = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
        const retained = createRetainedUpdateRecovery(
          { runId, from, to: { ...from, version: "2.0.0" } },
          { env },
        );
        closeOpenClawStateDatabaseForTest();
        await expect(admitUpdateCommandRun({ opts: {}, root })).rejects.toBeInstanceOf(
          UpdateRecoveryRequiredError,
        );
        expect(loadUpdateRecovery(runId, { env })).toEqual(retained);
        await expect(fs.stat(callerState)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        const run = await admitUpdateCommandRun({ opts: {}, root });
        expect(run.env.OPENCLAW_STATE_DIR).toBe(env.OPENCLAW_STATE_DIR);
        if (outcome === "unavailable") {
          const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
            root,
            updateInstallKind: "package",
            shouldRestart: true,
            phase: "inspect",
            jsonMode: true,
          });
          expect(inspected.serviceUpdateVerdict).toMatchObject({
            kind: "unavailable",
            inspectionReason: "service-manager-unavailable",
            message: expect.stringContaining("Restart the Gateway you launched manually"),
          });
          expect(inspected.blockMessage).toBeUndefined();
          expect(inspected.serviceEnv).toBeUndefined();
          await expect(fs.stat(serviceState)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      expect(native.stop).not.toHaveBeenCalled();
      expect(native.install).not.toHaveBeenCalled();
    },
  );
});
