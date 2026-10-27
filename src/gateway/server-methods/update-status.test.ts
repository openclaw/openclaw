import { randomUUID } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as snapshots from "../../infra/sqlite-readonly-location.js";
import { UpdateCampaignController } from "../../infra/update-campaign.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "../../infra/update-check-lifecycle.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import * as ledger from "../../infra/update-run-ledger.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { readUpdateRunStatus } from "../../infra/update-run-status.js";
import {
  getUpdateSchedule,
  resetUpdateStatusState,
  setUpdateScheduleCache,
} from "../../infra/update-status-state.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { createCoreGatewayMethodDescriptors } from "../methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { gatewayRequest } from "../request-frame.test-support.js";
import { handleGatewayRequest } from "../server-methods.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import { startUpdateRunWatcher } from "../update-run-watcher.js";
import { createLazyCoreHandlers } from "./lazy-core-handlers.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";
import { updateStatusHandlers } from "./update-status.js";

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
let owner: UpdateCampaignController;

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
  home = await createTempHomeEnv("openclaw-update-status-");
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
  owner = new UpdateCampaignController(lifecycle.scheduler);
  lifecycle.campaign = owner;
});
afterEach(async () => {
  await lifecycle.stop();
  await lifecycle.scheduler.stop();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  warn.mockClear();
  resetUpdateStatusState();
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
