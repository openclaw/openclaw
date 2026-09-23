import { hostname } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withGatewayServiceUpdateAuthority } from "../../daemon/service-update-authority.js";
import {
  acquireGatewayOwnerLease,
  type GatewayOwnerSupervisor,
} from "../../infra/gateway-owner-lease.js";
import { consumeGatewayRestartIntentPayloadSync } from "../../infra/restart-intent.js";
import {
  acquireGatewayLifecycleCoordinator,
  tryAcquireGatewayLifecycleCleanupCoordinator,
} from "../../infra/state-database-coordinator.js";
import * as processOwners from "../../infra/state-lease-process-owner.js";
import * as existingWrites from "../../state/openclaw-state-db-existing-write.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createServiceRestartIntent } from "./lifecycle-restart-intent.js";
import {
  createGatewayServiceRunArgs,
  lifecycleTestRuntime,
  lifecycleRuntimeLogs,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  service,
} from "./test-helpers/lifecycle-core-harness.js";

vi.mock("../../runtime.js", () => ({ defaultRuntime: lifecycleTestRuntime }));
vi.mock("./lifecycle-action-preflight.js", () => ({
  getServiceActionPreflightFailure: async () => null,
}));
vi.mock("./lifecycle-audit.js", () => ({
  createServiceLifecycleMutationAudit: () => undefined,
  appendServiceLifecycleRepairAudit: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { runServiceRestart } = await import("./lifecycle-core.js");

function beforeIntentWriteAdmission(operation: () => void) {
  const write = existingWrites.runExistingOpenClawStateWriteTransaction;
  vi.spyOn(existingWrites, "runExistingOpenClawStateWriteTransaction").mockImplementation(
    (mutate, options, contract) => {
      if (contract.operationLabel === "gateway.restart-intent.write") {
        operation();
      }
      return write(mutate, options, contract);
    },
  );
}

function publishServingOwner(
  pid: number,
  mode: "supervised" | "foreground" = "supervised",
  supervisor: GatewayOwnerSupervisor | null = {
    kind: "systemd",
    name: "openclaw-gateway.service",
  },
) {
  const { db } = openOpenClawStateDatabase();
  const now = Date.now();
  db.prepare(
    `INSERT INTO state_leases
     (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
     VALUES ('gateway-owner', 'global', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, lease_key) DO UPDATE SET
       owner = excluded.owner, payload_json = excluded.payload_json`,
  ).run(
    `generation-${pid}`,
    now + 60_000,
    now,
    JSON.stringify({
      owner: { pid, host: hostname(), startedAt: 1 },
      port: 18789,
      mode,
      supervisor,
    }),
    now,
    now,
  );
}

beforeEach(() => {
  resetLifecycleRuntimeLogs();
  lifecycleTestRuntime.error.mockClear();
  resetLifecycleServiceMocks();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-restart-intent-cli-"));
  vi.stubEnv("OPENCLAW_PROFILE", "default");
  vi.stubEnv("OPENCLAW_SYSTEMD_UNIT", "");
  vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", "");
  service.readRuntime.mockResolvedValue({ status: "running", pid: process.pid + 1 });
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  {
    platform: "linux",
    supervisor: { kind: "systemd", name: "openclaw-gateway.service" },
    serviceState: false,
  },
  {
    platform: "darwin",
    supervisor: { kind: "launchd", name: "ai.openclaw.gateway" },
    serviceState: false,
  },
  {
    platform: "linux",
    supervisor: { kind: "systemd", name: "openclaw-gateway.service" },
    serviceState: true,
  },
  {
    platform: "linux",
    supervisor: { kind: "systemd", name: "openclaw-gateway" },
    serviceState: false,
  },
] as const)(
  "delivers the managed $platform/$supervisor.name restart intent to the serving owner (service state=$serviceState)",
  async ({ platform, supervisor, serviceState }) => {
    const stateDir = tempDirs.make("openclaw-serving-state-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    if (!serviceState) {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    }
    const coordinator = acquireGatewayLifecycleCoordinator({
      databasePath: resolveOpenClawStateSqlitePath(env),
    });
    const lease = acquireGatewayOwnerLease({
      env,
      port: 18789,
      mode: "supervised",
      supervisor,
    });
    try {
      await lease.ready;
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      service.readRuntime.mockResolvedValue({
        status: "running",
        pid: process.pid + 1,
        ...(platform === "linux" ? { systemd: { unit: "openclaw-gateway.service" } } : {}),
      });
      service.readCommand.mockResolvedValue({
        programArguments: ["node", "openclaw.mjs", "gateway", "run"],
        environment: { OPENCLAW_STATE_DIR: stateDir },
      });
      let consumed: ReturnType<typeof consumeGatewayRestartIntentPayloadSync> = null;
      service.restart.mockImplementationOnce(async () => {
        consumed = consumeGatewayRestartIntentPayloadSync(env);
        return { outcome: "completed" };
      });

      await expect(
        runServiceRestart({
          ...createGatewayServiceRunArgs(),
          opts: { json: true, preserveDefinition: true, restartIntent: { waitMs: 30_000 } },
        }),
      ).resolves.toBe(true);

      expect(consumed).toEqual({ reason: "gateway.restart", waitMs: 30_000 });
      expect(consumeGatewayRestartIntentPayloadSync(env)).toBeNull();
    } finally {
      await lease.release();
      coordinator.release();
    }
  },
);

it("targets the replacement published before restart-intent write admission", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  // Synthetic process identities isolate the race; lease storage and intent consumption are real.
  vi.spyOn(processOwners, "readStateLeaseProcessOwnerStatus").mockReturnValue("live");
  const coordinator = acquireGatewayLifecycleCoordinator({
    databasePath: resolveOpenClawStateSqlitePath(process.env),
  });
  try {
    publishServingOwner(process.pid + 2);
    let publications = 0;
    beforeIntentWriteAdmission(() => {
      publishServingOwner(process.pid);
      publications += 1;
    });
    let consumed: ReturnType<typeof consumeGatewayRestartIntentPayloadSync> = null;
    service.restart.mockImplementationOnce(async () => {
      consumed = consumeGatewayRestartIntentPayloadSync();
      return { outcome: "completed" };
    });

    await expect(runServiceRestart(createGatewayServiceRunArgs())).resolves.toBe(true);

    expect(publications).toBe(1);
    expect(consumed).toEqual({ reason: "gateway.restart" });
  } finally {
    coordinator.release();
  }
});

it.each([
  { state: "dead", mode: "supervised", name: "openclaw-gateway.service" },
  { state: "unknown", mode: "supervised", name: "openclaw-gateway.service" },
  { state: "live", mode: "foreground", name: "openclaw-gateway.service" },
  { state: "live", mode: "supervised", name: "another-gateway.service" },
  { state: "live", mode: "supervised", name: null },
] as const)(
  "refuses restart for an unrelated or unverifiable serving owner ($state/$mode/$name)",
  async ({ state, mode, name }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(processOwners, "readStateLeaseProcessOwnerStatus").mockReturnValue(state);
    const { db } = openOpenClawStateDatabase();
    const coordinator = acquireGatewayLifecycleCoordinator({
      databasePath: resolveOpenClawStateSqlitePath(process.env),
    });
    try {
      publishServingOwner(
        process.pid + 2,
        mode,
        mode === "supervised" ? { kind: "systemd", name } : null,
      );
      service.readRuntime.mockResolvedValue({ status: "running", pid: process.pid });

      await expect(runServiceRestart(createGatewayServiceRunArgs())).rejects.toThrow("__exit__:1");

      expect(db.prepare("SELECT count(*) AS count FROM gateway_restart_intent").get()).toEqual({
        count: 0,
      });
      expect(service.restart).not.toHaveBeenCalled();
      expect(lifecycleRuntimeLogs.join("\n")).toContain("live serving Gateway owner");
    } finally {
      coordinator.release();
    }
  },
);

it.each([true, false])(
  "refuses a recovered service restart when command inspection fails (json=%s)",
  async (json) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const { db } = openOpenClawStateDatabase();
    publishServingOwner(process.pid);
    vi.spyOn(processOwners, "readStateLeaseProcessOwnerStatus").mockReturnValue("live");
    service.readRuntime.mockResolvedValue({ status: "running", pid: process.pid + 1 });
    service.readCommand.mockRejectedValue(new Error("native command inspection unavailable"));

    await expect(
      createServiceRestartIntent({ serviceNoun: "Gateway", service }).prepare(),
    ).rejects.toMatchObject({
      name: "GatewayRestartPreparationError",
      code: "GATEWAY_RESTART_PREPARATION_REFUSED",
      reason: "service-command",
    });
    await expect(
      runServiceRestart({ ...createGatewayServiceRunArgs(), opts: { json } }),
    ).rejects.toThrow("__exit__:1");

    expect(db.prepare("SELECT count(*) AS count FROM gateway_restart_intent").get()).toEqual({
      count: 0,
    });
    expect(service.restart).not.toHaveBeenCalled();
    const output = [...lifecycleRuntimeLogs, ...lifecycleTestRuntime.error.mock.calls.flat()].join(
      "\n",
    );
    expect(output).toContain("GATEWAY_RESTART_PREPARATION_REFUSED");
    expect(output).toContain("effective service command");
    expect(output).toContain("Gateway was not signaled");
  },
);

it("refuses a recovered service restart when its effective command is missing", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const { db } = openOpenClawStateDatabase();
  service.readCommand.mockResolvedValue(null);

  await expect(runServiceRestart(createGatewayServiceRunArgs())).rejects.toThrow("__exit__:1");

  expect(service.restart).not.toHaveBeenCalled();
  expect(db.prepare("SELECT count(*) AS count FROM gateway_restart_intent").get()).toEqual({
    count: 0,
  });
  expect(lifecycleRuntimeLogs.join("\n")).toContain("effective service command");
});

it("refuses native restart when restart intent cannot be recorded", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const { db } = openOpenClawStateDatabase();
  beforeIntentWriteAdmission(() => {
    throw new Error("write admission unavailable");
  });

  await expect(runServiceRestart(createGatewayServiceRunArgs())).rejects.toThrow("__exit__:1");

  expect(service.restart).not.toHaveBeenCalled();
  expect(db.prepare("SELECT count(*) AS count FROM gateway_restart_intent").get()).toEqual({
    count: 0,
  });
  expect(lifecycleRuntimeLogs.join("\n")).toContain("Cannot record restart intent");
});

it("restarts a verified inactive service without intent and releases startup exclusion", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const { db } = openOpenClawStateDatabase();
  service.readRuntime.mockResolvedValue({ status: "stopped" });
  service.restart.mockImplementationOnce(async () => {
    const exclusion = tryAcquireGatewayLifecycleCleanupCoordinator({
      databasePath: resolveOpenClawStateSqlitePath(process.env),
    });
    expect(exclusion).not.toBeNull();
    exclusion?.release();
    return { outcome: "completed" };
  });

  await expect(runServiceRestart(createGatewayServiceRunArgs())).resolves.toBe(true);

  expect(service.restart).toHaveBeenCalledOnce();
  expect(db.prepare("SELECT count(*) AS count FROM gateway_restart_intent").get()).toEqual({
    count: 0,
  });
});

it("refuses stopped native status while unpublished Gateway startup holds authority", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const { db } = openOpenClawStateDatabase();
  const coordinator = acquireGatewayLifecycleCoordinator({
    databasePath: resolveOpenClawStateSqlitePath(process.env),
  });
  service.readRuntime.mockResolvedValue({ status: "stopped" });
  try {
    await expect(runServiceRestart(createGatewayServiceRunArgs())).rejects.toThrow("__exit__:1");

    expect(service.restart).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) AS count FROM gateway_restart_intent").get()).toEqual({
      count: 0,
    });
  } finally {
    coordinator.release();
  }
});

it("targets the verified serving child even when native status reports stopped", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(processOwners, "readStateLeaseProcessOwnerStatus").mockReturnValue("live");
  const coordinator = acquireGatewayLifecycleCoordinator({
    databasePath: resolveOpenClawStateSqlitePath(process.env),
  });
  service.readRuntime.mockResolvedValue({ status: "stopped" });
  try {
    publishServingOwner(process.pid);
    let consumed: ReturnType<typeof consumeGatewayRestartIntentPayloadSync> = null;
    service.restart.mockImplementationOnce(async () => {
      consumed = consumeGatewayRestartIntentPayloadSync();
      return { outcome: "completed" };
    });

    await expect(runServiceRestart(createGatewayServiceRunArgs())).resolves.toBe(true);

    expect(consumed).toEqual({ reason: "gateway.restart" });
  } finally {
    coordinator.release();
  }
});

it.each(["runtime", "command", "write admission"])(
  "revalidates update authority after native %s inspection before recording intent",
  async (inspection) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const { db } = openOpenClawStateDatabase();
    let current = true;
    if (inspection === "runtime") {
      service.readRuntime.mockImplementationOnce(async () => {
        current = false;
        return { status: "running", pid: process.pid };
      });
    } else if (inspection === "command") {
      service.readCommand.mockImplementationOnce(async () => {
        current = false;
        return { programArguments: [] };
      });
    } else {
      beforeIntentWriteAdmission(() => {
        current = false;
      });
    }

    await expect(
      withGatewayServiceUpdateAuthority(
        () => {
          if (!current) {
            throw new Error("update owner revoked");
          }
        },
        () => runServiceRestart(createGatewayServiceRunArgs()),
      ),
    ).rejects.toThrow();

    expect(service.restart).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) AS count FROM gateway_restart_intent").get()).toEqual({
      count: 0,
    });
  },
);
