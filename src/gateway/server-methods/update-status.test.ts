import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateCheckLifecycle } from "../../infra/update-check-lifecycle.js";
import {
  closeUpdateFixtureDatabases,
  resetUpdateFixtureModules,
} from "../../infra/update-fixture.test-support.js";
import type { TempHomeEnv } from "../../test-utils/temp-home.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

let { acquireGatewayLock } = await import("../../infra/gateway-lock.js");
let { resolveUpdateCaptureRoot } = await import("../../infra/update-capture-paths.js");
let { UPDATE_CAPTURE_PRIVACY_MARKER } =
  await import("../../infra/update-capture-privacy-marker.js");
let snapshots = await import("../../infra/sqlite-readonly-location.js");
let { UpdateCampaignController } = await import("../../infra/update-campaign.js");
let { createGatewayUpdateLifecycle } = await import("../../infra/update-check-lifecycle.js");
let { readUpdateRunDriver } = await import("../../infra/update-run-driver.js");
let ledger = await import("../../infra/update-run-ledger.js");
let { createUpdateRun, finishUpdateRun, getUpdateRun } =
  await import("../../infra/update-run-ledger.js");
let { readUpdateRunStatus } = await import("../../infra/update-run-status.js");
let { getUpdateSchedule, setUpdateScheduleCache } =
  await import("../../infra/update-status-state.js");
let { createSubsystemLogger } = await import("../../logging/subsystem.js");
let {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} = await import("../../process/gateway-work-admission.js");
let { createDeferredCore } = await import("../../shared/deferred.js");
let { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } =
  await import("../../state/openclaw-state-db.js");
let { claimOpenClawStateOwnership } =
  await import("../../state/openclaw-state-ownership-operations.js");
let { createTestGatewayScheduler } = await import("../../test-utils/gateway-scheduler-clock.js");
let { observeMainThreadSql } =
  await import("../../test-utils/main-thread-sql-spies.test-support.js");
let { createTempHomeEnv } = await import("../../test-utils/temp-home.js");
let { createCoreGatewayMethodDescriptors } = await import("../methods/core-method-policy.js");
let { createGatewayMethodRegistry } = await import("../methods/registry.js");
let { gatewayRequest } = await import("../request-frame.test-support.js");
let { handleGatewayRequest } = await import("../server-methods.js");
let { gatewayConnect } = await import("../server/client-fixtures.test-support.js");
let { startUpdateRunWatcher } = await import("../update-run-watcher.js");
let { createLazyCoreHandlers } = await import("./lazy-core-handlers.js");
let { updateStatusHandlers } = await import("./update-status.js");

async function importUpdateFixtureModules() {
  ({ acquireGatewayLock } = await import("../../infra/gateway-lock.js"));
  ({ resolveUpdateCaptureRoot } = await import("../../infra/update-capture-paths.js"));
  ({ UPDATE_CAPTURE_PRIVACY_MARKER } =
    await import("../../infra/update-capture-privacy-marker.js"));
  snapshots = await import("../../infra/sqlite-readonly-location.js");
  ({ UpdateCampaignController } = await import("../../infra/update-campaign.js"));
  ({ createGatewayUpdateLifecycle } = await import("../../infra/update-check-lifecycle.js"));
  ({ readUpdateRunDriver } = await import("../../infra/update-run-driver.js"));
  ledger = await import("../../infra/update-run-ledger.js");
  ({ createUpdateRun, finishUpdateRun, getUpdateRun } =
    await import("../../infra/update-run-ledger.js"));
  ({ readUpdateRunStatus } = await import("../../infra/update-run-status.js"));
  ({ getUpdateSchedule, setUpdateScheduleCache } =
    await import("../../infra/update-status-state.js"));
  ({ createSubsystemLogger } = await import("../../logging/subsystem.js"));
  ({
    beginGatewayRestartSignalAdmission,
    getActiveGatewayRootWorkCount,
    markGatewayRestartDraining,
    resetGatewayWorkAdmission,
    tryBeginGatewaySuspendAdmission,
  } = await import("../../process/gateway-work-admission.js"));
  ({ createDeferredCore } = await import("../../shared/deferred.js"));
  ({ closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } =
    await import("../../state/openclaw-state-db.js"));
  ({ claimOpenClawStateOwnership } =
    await import("../../state/openclaw-state-ownership-operations.js"));
  ({ createTestGatewayScheduler } = await import("../../test-utils/gateway-scheduler-clock.js"));
  ({ observeMainThreadSql } =
    await import("../../test-utils/main-thread-sql-spies.test-support.js"));
  ({ createTempHomeEnv } = await import("../../test-utils/temp-home.js"));
  ({ createCoreGatewayMethodDescriptors } = await import("../methods/core-method-policy.js"));
  ({ createGatewayMethodRegistry } = await import("../methods/registry.js"));
  ({ gatewayRequest } = await import("../request-frame.test-support.js"));
  ({ handleGatewayRequest } = await import("../server-methods.js"));
  ({ gatewayConnect } = await import("../server/client-fixtures.test-support.js"));
  ({ startUpdateRunWatcher } = await import("../update-run-watcher.js"));
  ({ createLazyCoreHandlers } = await import("./lazy-core-handlers.js"));
  ({ updateStatusHandlers } = await import("./update-status.js"));
}

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateEffectiveChannel: async () => "stable",
}));

vi.mock("../../infra/update-status-schedule.js", () => ({
  getGatewayUpdateSchedule: () => getUpdateSchedule(),
  refreshGatewayUpdateStatus: async () => {},
}));

vi.mock("../server-update-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-update-sentinel.js")>()),
  getLatestUpdateRestartSentinel: () => null,
  refreshLatestUpdateRestartSentinel: async () => null,
  prepareLatestUpdateRestartSentinel: async () => null,
}));

type UpdateReadMethod = "update.status" | "update.runs.get" | "update.runs.list";

const warn = vi.fn();
const logGateway: GatewayRequestContext["logGateway"] = {
  ...createSubsystemLogger("gateway-test"),
  warn,
};

function expectPartial(respond: unknown, payload: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(payload));
}

function expectReply(respond: unknown, payload: unknown) {
  expect(respond).toHaveBeenCalledWith(true, payload);
}

function expectError(respond: unknown, error: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(error));
}
const emptyStatus = { sentinel: null, updateAvailable: null, effectiveChannel: "stable" };
async function expectStatus(runs: Record<string, unknown> = {}) {
  expectReply(await read("update.status"), { ...emptyStatus, ...runs });
}
async function expectRun(runId: string, run: unknown) {
  expectReply(await read("update.runs.get", { runId }), { run });
}
async function expectRuns(runs: unknown[], params: { limit?: number } = {}) {
  expectReply(await read("update.runs.list", params), { runs });
}
function agedRun(minutes: number, options: Parameters<typeof createUpdateRun>[0]) {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now - minutes * 60_000);
  const run = createUpdateRun(options);
  clock.mockReturnValue(now);
  return run;
}
async function observeWatcher(
  check: (broadcast: ReturnType<typeof vi.fn>, watcherWarn: ReturnType<typeof vi.fn>) => void,
) {
  const observed = createDeferredCore();
  const broadcast = vi.fn(() => observed.resolve());
  const watcherWarn = vi.fn((message: string) => {
    if (message.startsWith("update run watcher stopped:")) {
      observed.resolve();
    }
  });
  const watcher = startUpdateRunWatcher({ lifecycle, broadcast, log: { warn: watcherWarn } });
  try {
    await observed.promise;
    check(broadcast, watcherWarn);
  } finally {
    await watcher.stop();
  }
}

async function read(method: UpdateReadMethod, params: Record<string, unknown> = {}) {
  const respond = vi.fn<RespondFn>();
  const handler = expectDefined(updateStatusHandlers[method], method);
  await handler({
    req: gatewayRequest(method, method, params),
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {
      getRuntimeConfig: () => ({ update: { channel: "stable" } }),
      logGateway,
    } as GatewayRequestContext,
  });
  return respond;
}

let home: TempHomeEnv;
let lifecycle: UpdateCheckLifecycle;
let owner: InstanceType<typeof UpdateCampaignController>;

function announceCampaign(version = "2026.9.6") {
  owner.announce({
    target: { kind: "package", version },
    apply: async () => "applied",
    onChange: (campaign) =>
      setUpdateScheduleCache({
        next: { channel: "stable", autoEnabled: true, ...(campaign ? { campaign } : {}) },
      }),
  });
  expect(owner.adopt().status).toBe("adopted");
  return expectDefined(owner.getState(), "campaign state");
}

beforeEach(async () => {
  await resetUpdateFixtureModules();
  await importUpdateFixtureModules();
  home = await createTempHomeEnv("openclaw-update-status-");
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
  owner = new UpdateCampaignController(lifecycle.scheduler);
  lifecycle.campaign = owner;
});
afterEach(async () => {
  await lifecycle.stop();
  await lifecycle.scheduler.stop();
  await closeUpdateFixtureDatabases();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  warn.mockClear();
  await home.restore();
});

it.each(["failed", "running", "unrelated", "hidden-run retry"] as const)(
  "reconciles an applying campaign against %s history",
  async (kind) => {
    const campaign = announceCampaign();
    const run = createUpdateRun({
      trigger: "campaign",
      origin: { campaignId: kind === "unrelated" ? randomUUID() : campaign.id },
    });
    const keepCampaign = kind === "running" || kind === "unrelated";
    if (!keepCampaign) {
      owner.bindRun(campaign.id, run.runId);
    }
    if (kind !== "running") {
      finishUpdateRun(run.runId, {
        status: kind === "unrelated" || kind === "hidden-run retry" ? "failed" : kind,
        ...(kind === "failed" ? { reason: "database-schema-preflight" } : {}),
      });
    }
    let lastRunId = run.runId;
    if (kind === "hidden-run retry") {
      vi.spyOn(Date, "now").mockReturnValue(run.createdAtMs + 1);
      const newer = createUpdateRun({ trigger: "cli" });
      finishUpdateRun(newer.runId, { status: "skipped", reason: "dry-run" });
      lastRunId = newer.runId;
      vi.spyOn(ledger, "getUpdateRunAsync").mockRejectedValueOnce(new Error("ledger read failed"));
      expectPartial(await read("update.status"), {
        lastRun: expect.objectContaining({ runId: newer.runId }),
        schedule: { channel: "stable", autoEnabled: true, campaign },
      });
      expect(owner.getState()).toEqual(campaign);
      expect(warn).toHaveBeenCalledWith(
        "update.status campaign run lookup failed: ledger read failed",
      );
    }
    expectPartial(await read("update.status"), {
      lastRun: expect.objectContaining({
        runId: lastRunId,
        ...(kind === "hidden-run retry" ? {} : { status: kind === "unrelated" ? "failed" : kind }),
      }),
      schedule: {
        channel: "stable",
        autoEnabled: true,
        ...(keepCampaign ? { campaign } : {}),
      },
    });
    expect(owner.getState()).toEqual(keepCampaign ? campaign : undefined);
  },
);

it("does not clear a replacement campaign after an awaited ledger read", async () => {
  const original = announceCampaign();
  const run = createUpdateRun({ trigger: "campaign", origin: { campaignId: original.id } });
  owner.bindRun(original.id, run.runId);
  finishUpdateRun(run.runId, { status: "failed" });
  const readStatus = ledger.getUpdateRunStatusAsync;
  vi.spyOn(ledger, "getUpdateRunStatusAsync").mockImplementationOnce(async () => {
    const status = await readStatus();
    owner.clear();
    announceCampaign("2026.9.7");
    return status;
  });

  const respond = await read("update.status");
  const replacement = owner.getState();
  expect(replacement).toMatchObject({ state: "applying" });
  expect(replacement?.id).not.toBe(original.id);
  expectPartial(respond, {
    schedule: { channel: "stable", autoEnabled: true, campaign: replacement },
  });
});

it("keeps private recovery receipts durable while status and history stay public", async () => {
  const capture = {
    manifestSha256: "a".repeat(64),
    configWrites: [
      {
        path: path.join(home.home, "private.json"),
        beforeHash: null,
        contiguous: true,
        afterHash: "b".repeat(64),
      },
    ],
    status: "pending" as const,
  };
  const run = createUpdateRun({ trigger: "api", origin: { updateRecoveryCapture: capture } });
  const publicRun = { ...run, origin: {} };
  const status = await readUpdateRunStatus();
  expect(status).toMatchObject({ activeRun: publicRun, lastRun: publicRun });
  expect(JSON.stringify(status)).not.toContain("updateRecoveryCapture");
  await expectStatus({ activeRun: publicRun, lastRun: publicRun });
  await expectRun(run.runId, publicRun);
  await expectRuns([publicRun]);
  markGatewayRestartDraining();
  await expectRun(run.runId, publicRun);
  expect(getUpdateRun(run.runId)?.origin.updateRecoveryCapture).toEqual(capture);
  expect(run.origin.updateRecoveryCapture).toEqual(capture);
  expect(warn).not.toHaveBeenCalled();
});

it.each(["accepting", "suspension"] as const)(
  "rechecks root ownership after a lazy restart read resets into %s",
  async (nextPhase) => {
    markGatewayRestartDraining();
    const preparing = createDeferredCore();
    const prepared = createDeferredCore();
    const reconciling = createDeferredCore();
    const reconciled = createDeferredCore();
    const reconcile = vi
      .spyOn(ledger, "getUpdateRunWithReconciliationAsync")
      .mockImplementation(async () => {
        reconciling.resolve();
        await reconciled.promise;
        return { run: undefined };
      });
    const handlers = createLazyCoreHandlers({
      methods: ["update.runs.get"],
      loadHandlers: async () => {
        preparing.resolve();
        await prepared.promise;
        return updateStatusHandlers;
      },
    });
    const respond = vi.fn<RespondFn>();
    const request = handleGatewayRequest({
      req: gatewayRequest("read-after-rollback", "update.runs.get", { runId: randomUUID() }),
      respond,
      client: {
        connId: "read-after-rollback",
        connect: gatewayConnect(["operator.admin"], { id: "cli", platform: "linux", mode: "cli" }),
      },
      isWebchatConnect: () => false,
      context: { logGateway } as GatewayRequestContext,
      methodRegistry: createGatewayMethodRegistry(createCoreGatewayMethodDescriptors(handlers)),
    });
    await preparing.promise;
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    resetGatewayWorkAdmission();
    if (nextPhase === "suspension") {
      expect(tryBeginGatewaySuspendAdmission(() => {})).not.toBeNull();
      prepared.resolve();
      await request;
      expect(reconcile).not.toHaveBeenCalled();
      expectError(respond, { code: "UNAVAILABLE" });
    } else {
      prepared.resolve();
      await reconciling.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      reconciled.resolve();
      await request;
      expectReply(respond, { run: null });
    }
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  },
);

it.each(["signal", "drain"] as const)(
  "reads recorded progress without reconciliation during restart %s",
  async (phase) => {
    const run = agedRun(25 * 60, { trigger: "cli", before: { version: "2026.9.2" } });
    if (phase === "signal") {
      expect(beginGatewayRestartSignalAdmission()).not.toBeNull();
    } else {
      markGatewayRestartDraining();
    }
    const response = await read("update.runs.get", { runId: run.runId });
    if (phase === "signal") {
      expectError(response, { code: "UNAVAILABLE" });
    } else {
      expectReply(response, { run });
    }
    expect(getUpdateRun(run.runId)).toEqual(run);
    expect(warn).not.toHaveBeenCalled();

    resetGatewayWorkAdmission();
    await read("update.runs.get", { runId: run.runId });
    expect(getUpdateRun(run.runId)).toMatchObject({
      status: "failed",
      reason: "legacy-driver-expired",
    });
  },
);

it("reads fresh status concurrently without copying the shared database", async () => {
  const run = createUpdateRun({ trigger: "api" });
  const backup = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationFromOwnedDatabase");
  const sql = observeMainThreadSql();
  sql.calibrate();
  try {
    for (const respond of await Promise.all([read("update.status"), read("update.status")])) {
      expectPartial(respond, { activeRun: run, lastRun: run });
    }
    expect(sql.count()).toBe(0);
  } finally {
    sql.restore();
  }
  const completed = finishUpdateRun(run.runId, { status: "succeeded" });
  const respond = await read("update.status");
  expectReply(respond, { ...emptyStatus, lastRun: completed });
  expect(backup).not.toHaveBeenCalled();
});

it.each(
  (["update.status", "update.runs.get"] as const).flatMap((method) =>
    (["refused", "dead driver", "expired legacy"] as const).map((kind) => ({ method, kind })),
  ),
)("serves $method history after $kind reconciliation", async ({ method, kind }) => {
  const driver =
    kind === "dead driver"
      ? expectDefined(readUpdateRunDriver(), "local driver identity")
      : undefined;
  const run = agedRun(kind === "dead driver" ? 31 : 25 * 60, {
    trigger: "cli",
    origin: driver
      ? { driver: { ...driver, startIdentity: String(Number(driver.startIdentity) + 1) } }
      : undefined,
    ...(kind === "expired legacy" ? { before: { version: "2026.9.2" } } : {}),
  });
  if (kind === "refused") {
    claimOpenClawStateOwnership("test-supervisor", {
      env: { ...process.env, OPENCLAW_SUPERVISOR_MODE: "external" },
    });
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
  }
  const respond = await read(method, method === "update.runs.get" ? { runId: run.runId } : {});
  if (kind === "refused") {
    expectPartial(
      respond,
      method === "update.runs.get" ? { run } : { activeRun: run, lastRun: run },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/reconciliation failed:.*externally supervised/u),
    );
    expect(getUpdateRun(run.runId)).toEqual(run);
  } else {
    const result = {
      status: "failed",
      reason: kind === "dead driver" ? "abandoned" : "legacy-driver-expired",
    };
    expect(getUpdateRun(run.runId)).toMatchObject({
      ...result,
      ...(kind === "expired legacy" ? { phase: "finished" } : {}),
    });
    if (kind === "expired legacy") {
      expectPartial(respond, {
        [method === "update.status" ? "lastRun" : "run"]: expect.objectContaining(result),
      });
    }
  }
});

it("projects distinct active and latest runs and reads persisted history in creation order", async () => {
  await expectStatus();
  await expectRuns([]);

  const currentTime = Date.now();
  const now = vi.spyOn(Date, "now").mockReturnValue(currentTime - 2_000);
  const active = createUpdateRun({ trigger: "api" });
  now.mockReturnValue(currentTime - 1_000);
  const latest = finishUpdateRun(createUpdateRun({ trigger: "cli" }).runId, {
    status: "skipped",
    reason: "dry-run",
  });
  await expectStatus({ activeRun: active, lastRun: latest });
  await expectRun(active.runId, active);
  await expectRun(randomUUID(), null);

  now.mockReturnValue(currentTime);
  const completed = finishUpdateRun(active.runId, { status: "succeeded" });
  await expectStatus({ lastRun: latest });
  const nativeCalls = observeMainThreadSql();
  await expectRuns([latest, completed]);
  await expectRuns([latest], { limit: 1 });
  nativeCalls.expectIdle();
});

it("rejects malformed identities, invalid limits, and unsupported query fields", async () => {
  createUpdateRun({ trigger: "api" });
  const invalidRequests: Array<[UpdateReadMethod, Record<string, unknown>]> = [
    ["update.runs.get", {}],
    ["update.runs.get", { runId: "not-a-uuid" }],
    ["update.runs.list", { limit: 0 }],
    ["update.runs.list", { limit: 101 }],
    ["update.runs.list", { limit: 1.5 }],
    ["update.runs.list", { active: true }],
    ["update.status", { runId: randomUUID() }],
  ];
  for (const [method, params] of invalidRequests) {
    const respond = await read(method, params);
    expect(respond, `${method}: ${JSON.stringify(params)}`).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  }
});
it("reconciles an expired legacy admission on Gateway watcher startup", async () => {
  const legacy = agedRun(25 * 60, { trigger: "cli", before: { version: "2026.9.2" } });
  await observeWatcher((broadcast) => {
    expect(getUpdateRun(legacy.runId)).toMatchObject({
      phase: "finished",
      status: "failed",
      reason: "legacy-driver-expired",
    });
    expect(broadcast).toHaveBeenCalledWith(
      "update.run.changed",
      expect.objectContaining({ runId: legacy.runId, status: "failed" }),
    );
  });
});

it("watches a valid active update when newer terminal history is malformed", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now - 1_000);
  const active = createUpdateRun({ trigger: "cli" });
  clock.mockReturnValue(now);
  const latest = finishUpdateRun(createUpdateRun({ trigger: "cli" }).runId, {
    status: "succeeded",
  });
  clock.mockRestore();
  const { db } = openOpenClawStateDatabase();
  db.prepare("UPDATE update_runs SET origin_json = ? WHERE run_id = ?").run(
    "not-json",
    latest.runId,
  );
  expect(getUpdateRun(active.runId)).toEqual(active);
  expect(() => getUpdateRun(latest.runId)).toThrow();

  await observeWatcher((broadcast, watcherWarn) => {
    expect(broadcast).toHaveBeenCalledWith("update.run.changed", {
      runId: active.runId,
      phase: "requested",
      status: "running",
      updatedAtMs: active.updatedAtMs,
    });
    expect(lifecycle.scheduler.nextWakeAtMs).not.toBeNull();
    expect(watcherWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("update run watcher stopped:"),
    );
  });
});

it("reads explicit recovery storage off the Gateway thread without changing retained bytes", async () => {
  const directory = path.join(home.home, ".openclaw", "state");
  fs.mkdirSync(directory, { recursive: true });
  const original = path.join(directory, "openclaw.sqlite.pre-startup-migration-old.bak");
  fs.writeFileSync(original, "retained");
  expectReply(await read("update.status"), emptyStatus);
  const run = finishUpdateRun(createUpdateRun({ trigger: "cli" }).runId, { status: "succeeded" });
  const capture = path.join(resolveUpdateCaptureRoot(path.dirname(directory)), run.runId);
  fs.mkdirSync(capture, { recursive: true });
  fs.writeFileSync(path.join(capture, UPDATE_CAPTURE_PRIVACY_MARKER), "");
  fs.writeFileSync(path.join(capture, "original"), "capture");
  await closeOpenClawStateDatabaseAsync();
  const lock = await acquireGatewayLock({ role: "gateway", allowInTests: true });
  expect(lock).toBeTruthy();
  const sql = observeMainThreadSql();
  sql.calibrate();
  try {
    const response = await read("update.status", { includeRecoveryCopies: true });
    sql.expectIdle();
    expectPartial(response, {
      recoveryCopies: expect.objectContaining({
        byReason: expect.arrayContaining([
          {
            reason: "unmanifested-recovery-original",
            outcome: "protected",
            count: 1,
            logicalBytes: 8,
          },
        ]),
      }),
    });
    expect(fs.readFileSync(original, "utf8")).toBe("retained");
    expect(fs.readFileSync(path.join(capture, "original"), "utf8")).toBe("capture");
  } finally {
    sql.restore();
    await lock?.release();
  }
});
