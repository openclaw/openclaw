import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { GatewayOwnerLeaseIdentity } from "../../infra/gateway-owner-lease.js";
import * as updateCheck from "../../infra/update-check.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
} from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as shared from "./shared.js";
import * as finalizationConfig from "./update-command-config.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import * as freshDoctor from "./update-command-fresh-doctor.js";
import { validConfigSnapshot } from "./update-command-lifecycle.test-support.js";
import * as plugins from "./update-command-plugins.js";
import * as sourceRuntime from "./update-command-runtime.js";

const mocks = vi.hoisted(() => ({
  owner: vi.fn<typeof import("../../infra/gateway-owner-lease.js").readGatewayOwnerLease>(),
  readiness: vi.fn<typeof import("./update-command-readiness.js").observeUpdateGatewayReadiness>(),
  maintenance:
    vi.fn<typeof import("../../commands/doctor-maintenance.js").beginDoctorMaintenance>(),
}));
vi.mock("../../infra/gateway-owner-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-owner-lease.js")>()),
  readGatewayOwnerLease: mocks.owner,
}));
vi.mock("./update-command-readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-readiness.js")>()),
  observeUpdateGatewayReadiness: mocks.readiness,
}));
vi.mock("../../commands/doctor-maintenance.js", () => ({
  beginDoctorMaintenance: mocks.maintenance,
}));
vi.mock("./update-command-triage.js", () => ({
  withUpdateFailureTriage: async (_opts: unknown, _target: unknown, run: () => Promise<void>) =>
    run(),
}));
vi.mock("./update-command-failure-recovery.js", () => ({
  verifyUpdateFailureRecovery: async (params: { result: unknown }) => params.result,
}));
vi.mock("../../infra/update-candidate-state.sizes.js", () => ({
  readUpdateStateDatabaseSizes: vi.fn(async () => []),
}));
vi.mock("./update-command-config-snapshot.js", () => ({
  createUpdateConfigSnapshot: vi.fn(async () => {}),
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: vi.fn(async () => validConfigSnapshot),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const version = "2026.9.5";
const buildId = "synthetic-finalize-build";
const maintenanceRequired = new Error("Required Doctor maintenance still needs exclusive access.");
let root: string;
let holder: GatewayOwnerLeaseIdentity;

function readyObservation(mode: GatewayOwnerLeaseIdentity["mode"] = holder.mode) {
  return {
    health: {
      healthy: true,
      waitOutcome: "healthy" as const,
      runtime:
        mode === "foreground"
          ? { status: "stopped" as const }
          : { status: "running" as const, pid: holder.pid },
      portUsage: {
        port: holder.port,
        status: "busy" as const,
        listeners: [{ pid: holder.pid, command: "openclaw-gateway", address: "127.0.0.1" }],
        hints: [],
      },
      staleGatewayPids: [],
      gatewayVersion: version,
      gatewayBuildId: buildId,
      gatewayBootId: "synthetic-finalize-boot",
    },
    readyz: true,
    http: undefined,
    launchAgentRecovery: null,
  };
}

beforeEach(async () => {
  const base = dirs.make("finalize-maintenance-");
  root = path.join(base, "package");
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
  );
  await fs.writeFile(path.join(root, "dist", "build-info.json"), JSON.stringify({ buildId }));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(base, "state", "openclaw.json"));
  for (const key of [
    "OPENCLAW_UPDATE_RUN_ID",
    "OPENCLAW_UPDATE_RUN_HANDOFF",
    "OPENCLAW_UPDATE_POST_CORE",
  ]) {
    vi.stubEnv(key, undefined);
  }
  holder = {
    owner: "synthetic-serving-owner",
    pid: 4242,
    host: "synthetic-host",
    startedAt: 12345,
    port: 19483,
    mode: "foreground",
    supervisor: null,
    state: "live",
    expired: false,
  };
  mocks.owner.mockReset().mockImplementation(() => holder);
  mocks.readiness.mockReset().mockImplementation(async () => readyObservation());
  mocks.maintenance.mockReset().mockRejectedValue(maintenanceRequired);
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
  vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
  vi.spyOn(finalizationConfig, "persistRequestedUpdateChannel");
  vi.spyOn(finalizationConfig, "preparePostCorePluginConfig");
  vi.spyOn(sourceRuntime, "completeSourceUpdateRuntime").mockResolvedValue({ changed: false });
  vi.spyOn(freshDoctor, "runUpdateFinalizationDoctorInFreshProcess");
  vi.spyOn(plugins, "updatePluginsAfterCoreUpdate");
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function expectDeferred() {
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "warning",
      mode: "finalize",
      restart: false,
      postUpdate: {
        doctor: { status: "warning", warnings: [expect.stringContaining(holder.owner)] },
      },
    }),
  );
  const run = listUpdateRuns()[0]!;
  expect(run.status).toBe("succeeded");
  expect(run.steps).toContainEqual(
    expect.objectContaining({
      step: "finalize:doctor",
      status: "skipped",
      detail: expect.stringContaining(`PID ${holder.pid}`),
    }),
  );
  expect(run.steps).toContainEqual(
    expect.objectContaining({
      step: "warning:finalize:doctor:0",
      detail: expect.stringContaining("openclaw update repair"),
    }),
  );
  expect(finalizationConfig.persistRequestedUpdateChannel).not.toHaveBeenCalled();
  expect(finalizationConfig.preparePostCorePluginConfig).not.toHaveBeenCalled();
  expect(sourceRuntime.completeSourceUpdateRuntime).not.toHaveBeenCalled();
  expect(mocks.maintenance).not.toHaveBeenCalled();
  expect(freshDoctor.runUpdateFinalizationDoctorInFreshProcess).not.toHaveBeenCalled();
  expect(plugins.updatePluginsAfterCoreUpdate).not.toHaveBeenCalled();
}

it.each(["foreground", "supervised"] as const)(
  "defers all finalization writes for the verified %s holder",
  async (mode) => {
    holder.mode = mode;
    holder.supervisor =
      mode === "supervised" ? { kind: "systemd", name: "openclaw-gateway" } : null;
    vi.mocked(updateCheck.resolveUpdateInstallKind).mockResolvedValue(
      mode === "supervised" ? "git" : "package",
    );
    await updateFinalizeCommand({ json: true, yes: true, channel: "beta" });
    expectDeferred();
    expect(mocks.readiness).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: version,
        expectedBuildId: buildId,
        gatewayPort: holder.port,
        requireRunningService: mode === "supervised",
        deadlineMs: expect.any(Number),
      }),
    );
    expect(mocks.readiness.mock.calls[0]?.[0].recoverHealth).toBeUndefined();
  },
);

it("waits for the starting holder before publishing successful deferral", async () => {
  const entered = createDeferredCore();
  const ready = createDeferredCore<ReturnType<typeof readyObservation>>();
  mocks.readiness.mockImplementationOnce(async () => {
    entered.resolve();
    return ready.promise;
  });
  const finalizing = updateFinalizeCommand({ json: true, yes: true });
  await Promise.race([entered.promise, finalizing]);
  try {
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(mocks.maintenance).not.toHaveBeenCalled();
  } finally {
    ready.resolve(readyObservation());
  }
  await finalizing;
  expectDeferred();
});

it.each([
  "dead",
  "died-during-wait",
  "changed-owner",
  "unhealthy",
  "not-ready",
  "version-mismatch",
  "build-mismatch",
  "foreign-listener",
  "supervised-stopped",
  "supervised-other-runtime",
])("does not bypass required maintenance for %s", async (kind) => {
  if (kind.startsWith("supervised-")) {
    holder.mode = "supervised";
    holder.supervisor = { kind: "systemd", name: "openclaw-gateway" };
  }
  const observation = readyObservation();
  if (kind === "dead") {
    holder.state = "dead";
  } else if (kind === "died-during-wait" || kind === "changed-owner") {
    mocks.readiness.mockImplementationOnce(async () => {
      holder =
        kind === "died-during-wait"
          ? { ...holder, state: "dead" }
          : { ...holder, owner: "synthetic-successor", startedAt: 12346 };
      return observation;
    });
  } else {
    if (kind === "foreign-listener") {
      observation.health.portUsage.listeners[0]!.pid += 1;
    } else if (kind === "not-ready") {
      observation.readyz = false;
    } else if (kind === "supervised-stopped") {
      observation.health.runtime = { status: "stopped" };
    } else if (kind === "supervised-other-runtime") {
      observation.health.runtime = { status: "running", pid: holder.pid + 1 };
    } else {
      observation.health.healthy = false;
      if (kind === "version-mismatch") {
        observation.health.gatewayVersion = "2026.9.4";
      }
      if (kind === "build-mismatch") {
        observation.health.gatewayBuildId = "synthetic-other-build";
      }
    }
    mocks.readiness.mockResolvedValueOnce(observation);
  }
  await expect(updateFinalizeCommand({ json: true, yes: true })).rejects.toBe(maintenanceRequired);
  expect(mocks.maintenance).toHaveBeenCalledOnce();
  expect(listUpdateRuns()[0]?.status).toBe("failed");
  expect(defaultRuntime.writeJson).not.toHaveBeenCalledWith(
    expect.objectContaining({ status: "warning" }),
  );
  if (kind === "dead") {
    expect(mocks.readiness).not.toHaveBeenCalled();
  }
});

it("requires installed build identity before considering maintenance deferral", async () => {
  await fs.unlink(path.join(root, "dist", "build-info.json"));
  await expect(updateFinalizeCommand({ json: true, yes: true })).rejects.toBe(maintenanceRequired);
  expect(mocks.readiness).not.toHaveBeenCalled();
  expect(mocks.maintenance).toHaveBeenCalledOnce();
  expect(listUpdateRuns()[0]?.status).toBe("failed");
});

it("leaves selected recovery history unacknowledged while maintenance remains deferred", async () => {
  const old = createUpdateRun({ trigger: "cli" });
  const before = finishUpdateRun(old.runId, { status: "failed", reason: "abandoned" });
  await updateFinalizeCommand({ json: true, yes: true }, [old.runId]);
  expectDeferred();
  expect(getUpdateRun(old.runId)).toEqual(before);
});
