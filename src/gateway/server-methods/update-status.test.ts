import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
import { refreshGatewayUpdateStatus } from "../../infra/update-status-schedule.js";
import {
  getUpdateSchedule,
  resetUpdateStatusState,
  setUpdateScheduleCache,
} from "../../infra/update-status-state.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveExternalSupervisorGuidance } from "../../plugins/supervisor-guidance-runtime.js";
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
import { handleGatewayRequest } from "../server-methods.js";
import { startUpdateRunWatcher } from "../update-run-watcher.js";
import { createLazyCoreHandlers } from "./lazy-core-handlers.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";
import { updateStatusHandlers } from "./update-status.js";

vi.mock("../../plugins/supervisor-guidance-runtime.js", () => ({
  resolveExternalSupervisorGuidance: vi.fn(async () => undefined),
}));

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateEffectiveChannel: async () => "stable",
}));

vi.mock("../../infra/update-status-schedule.js", () => ({
  getGatewayUpdateSchedule: () => getUpdateSchedule(),
  refreshGatewayUpdateStatus: vi.fn(async () => {}),
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

async function requestUpdateRead(
  method: UpdateReadMethod,
  params: Record<string, unknown> = {},
  getRuntimeConfig: GatewayRequestContext["getRuntimeConfig"] = () => ({
    update: { channel: "stable" },
  }),
) {
  const respond = vi.fn<RespondFn>();
  await expectDefined(
    updateStatusHandlers[method],
    method,
  )({
    req: { type: "req", id: method, method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {
      getRuntimeConfig,
      logGateway,
    } as GatewayRequestContext,
  });
  return respond;
}

let home: TempHomeEnv;
let lifecycle: UpdateCheckLifecycle;
let campaignOwner: UpdateCampaignController;

function announceCampaign(version = "2026.9.6") {
  campaignOwner.announce({
    target: { kind: "package", version },
    apply: async () => "applied",
    onChange: (campaign) =>
      setUpdateScheduleCache({
        next: { channel: "stable", autoEnabled: true, ...(campaign ? { campaign } : {}) },
      }),
  });
  expect(campaignOwner.adopt().status).toBe("adopted");
  return expectDefined(campaignOwner.getState(), "campaign state");
}

beforeEach(async () => {
  home = await createTempHomeEnv("openclaw-update-status-");
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
  campaignOwner = new UpdateCampaignController(lifecycle.scheduler);
  lifecycle.campaign = campaignOwner;
});
afterEach(async () => {
  await lifecycle.stop();
  await lifecycle.scheduler.stop();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  warn.mockClear();
  resetUpdateStatusState();
  vi.mocked(resolveExternalSupervisorGuidance).mockReset();
  await home.restore();
});

describe("update history RPCs", () => {
  it.each([
    "failed",
    "succeeded",
    "rolled-back",
    "skipped",
    "running",
    "unrelated",
    "hidden-run retry",
  ] as const)("reconciles an applying campaign against %s history", async (kind) => {
    const campaign = announceCampaign();
    const run = createUpdateRun({
      trigger: "campaign",
      origin: { campaignId: kind === "unrelated" ? randomUUID() : campaign.id },
    });
    const keepCampaign = kind === "running" || kind === "unrelated";
    if (!keepCampaign) {
      campaignOwner.bindRun(campaign.id, run.runId);
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
      expect(await requestUpdateRead("update.status")).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          lastRun: expect.objectContaining({ runId: newer.runId }),
          schedule: { channel: "stable", autoEnabled: true, campaign },
        }),
      );
      expect(campaignOwner.getState()).toEqual(campaign);
      expect(warn).toHaveBeenCalledWith(
        "update.status campaign run lookup failed: ledger read failed",
      );
    }
    expect(await requestUpdateRead("update.status")).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        lastRun: expect.objectContaining({
          runId: lastRunId,
          ...(kind === "hidden-run retry"
            ? {}
            : { status: kind === "unrelated" ? "failed" : kind }),
        }),
        schedule: {
          channel: "stable",
          autoEnabled: true,
          ...(keepCampaign ? { campaign } : {}),
        },
      }),
    );
    expect(campaignOwner.getState()).toEqual(keepCampaign ? campaign : undefined);
  });

  it("does not clear a replacement campaign after an awaited ledger read", async () => {
    const original = announceCampaign();
    const run = createUpdateRun({ trigger: "campaign", origin: { campaignId: original.id } });
    campaignOwner.bindRun(original.id, run.runId);
    finishUpdateRun(run.runId, { status: "failed" });
    const readStatus = ledger.getUpdateRunStatusAsync;
    vi.spyOn(ledger, "getUpdateRunStatusAsync").mockImplementationOnce(async () => {
      const status = await readStatus();
      campaignOwner.clear();
      announceCampaign("2026.9.7");
      return status;
    });

    const respond = await requestUpdateRead("update.status");
    const replacement = campaignOwner.getState();
    expect(replacement).toMatchObject({ state: "applying" });
    expect(replacement?.id).not.toBe(original.id);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        schedule: { channel: "stable", autoEnabled: true, campaign: replacement },
      }),
    );
  });

  it("projects current supervisor guidance without retaining commands in update history", async () => {
    const guidance = {
      version: 1 as const,
      action: "update" as const,
      name: "Deployment manager",
      runFrom: "Host",
      command: "deploy update gateway",
    };
    const run = createUpdateRun({ trigger: "api" });
    vi.mocked(resolveExternalSupervisorGuidance).mockResolvedValue(guidance);
    const first = await requestUpdateRead("update.status");
    expect(first).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        externalSupervisorGuidance: guidance,
      }),
    );
    expect(getUpdateRun(run.runId)).not.toHaveProperty("externalSupervisorGuidance");
    const history = await requestUpdateRead("update.runs.get", { runId: run.runId });
    expect(JSON.stringify(history.mock.calls)).not.toContain(guidance.command);
    vi.mocked(resolveExternalSupervisorGuidance).mockResolvedValue(undefined);
    const refreshed = await requestUpdateRead("update.status");
    expect(refreshed.mock.calls[0]?.[1]).not.toHaveProperty("externalSupervisorGuidance");
  });
  it("drops package guidance when its plugin is disabled during an update-status refresh", async () => {
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
    const pluginDir = path.join(home.home, "deployment");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      "throw new Error('must not load runtime');",
    );
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "deployment",
        version: "1.0.0",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "deployment",
        configSchema: { type: "object" },
        supervisorGuidance: {
          version: 1,
          name: "Deployment manager",
          actions: { update: "deploy update gateway" },
        },
      }),
    );
    const actual = await vi.importActual<
      typeof import("../../plugins/supervisor-guidance-runtime.js")
    >("../../plugins/supervisor-guidance-runtime.js");
    vi.mocked(resolveExternalSupervisorGuidance).mockImplementation(
      actual.resolveExternalSupervisorGuidance,
    );
    let config: OpenClawConfig = {
      update: { channel: "stable" },
      plugins: {
        load: { paths: [pluginDir] },
        allow: ["deployment"],
        entries: { deployment: { enabled: true } },
      },
    };
    const initial = await requestUpdateRead("update.status", {}, () => config);
    expect(initial.mock.calls[0]?.[1]).toMatchObject({
      externalSupervisorGuidance: { command: "deploy update gateway" },
    });
    const refreshing = createDeferredCore();
    const refreshed = createDeferredCore();
    vi.mocked(refreshGatewayUpdateStatus).mockImplementationOnce(async () => {
      refreshing.resolve();
      await refreshed.promise;
    });
    const pending = requestUpdateRead("update.status", { refreshCheckout: true }, () => config);
    await refreshing.promise;
    config = {
      ...config,
      plugins: { ...config.plugins, entries: { deployment: { enabled: false } } },
    };
    refreshed.resolve();
    const response = await pending;
    expect(response).toHaveBeenCalledWith(true, expect.any(Object));
    expect(response.mock.calls[0]?.[1]).not.toHaveProperty("externalSupervisorGuidance");
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
    expect(await requestUpdateRead("update.status")).toHaveBeenCalledWith(true, {
      sentinel: null,
      activeRun: publicRun,
      lastRun: publicRun,
      updateAvailable: null,
      effectiveChannel: "stable",
    });
    expect(await requestUpdateRead("update.runs.get", { runId: run.runId })).toHaveBeenCalledWith(
      true,
      { run: publicRun },
    );
    expect(await requestUpdateRead("update.runs.list")).toHaveBeenCalledWith(true, {
      runs: [publicRun],
    });
    markGatewayRestartDraining();
    expect(await requestUpdateRead("update.runs.get", { runId: run.runId })).toHaveBeenCalledWith(
      true,
      { run: publicRun },
    );
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
        req: {
          type: "req",
          id: "read-after-rollback",
          method: "update.runs.get",
          params: { runId: randomUUID() },
        },
        respond,
        client: {
          connId: "read-after-rollback",
          connect: {
            role: "operator",
            scopes: ["operator.admin"],
            client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
            minProtocol: 1,
            maxProtocol: 1,
          },
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
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
      } else {
        prepared.resolve();
        await reconciling.promise;
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        reconciled.resolve();
        await request;
        expect(respond).toHaveBeenCalledWith(true, { run: null });
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );

  it.each(["signal", "drain"] as const)(
    "reads recorded progress without reconciliation during restart %s",
    async (phase) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now - 25 * 60 * 60_000);
      const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
      clock.mockReturnValue(now);
      if (phase === "signal") {
        expect(beginGatewayRestartSignalAdmission()).not.toBeNull();
      } else {
        markGatewayRestartDraining();
      }
      const response = await requestUpdateRead("update.runs.get", { runId: run.runId });
      if (phase === "signal") {
        expect(response).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE" }),
        );
      } else {
        expect(response).toHaveBeenCalledWith(true, { run });
      }
      expect(getUpdateRun(run.runId)).toEqual(run);
      expect(warn).not.toHaveBeenCalled();

      resetGatewayWorkAdmission();
      await requestUpdateRead("update.runs.get", { runId: run.runId });
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
      for (const respond of await Promise.all([
        requestUpdateRead("update.status"),
        requestUpdateRead("update.status"),
      ])) {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ activeRun: run, lastRun: run }),
        );
      }
      expect(sql.count()).toBe(0);
    } finally {
      sql.restore();
    }
    const completed = finishUpdateRun(run.runId, { status: "succeeded" });
    const respond = await requestUpdateRead("update.status");
    expect(respond).toHaveBeenCalledWith(true, {
      sentinel: null,
      lastRun: completed,
      updateAvailable: null,
      effectiveChannel: "stable",
    });
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
    const now = Date.now();
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(now - (kind === "dead driver" ? 31 : 25 * 60) * 60_000);
    const run = createUpdateRun({
      trigger: "cli",
      ...(driver
        ? {
            origin: {
              driver: { ...driver, startIdentity: String(Number(driver.startIdentity) + 1) },
            },
          }
        : {}),
      ...(kind === "expired legacy" ? { before: { version: "2026.9.2" } } : {}),
    });
    clock.mockReturnValue(now);
    if (kind === "refused") {
      claimOpenClawStateOwnership("test-supervisor", {
        env: { ...process.env, OPENCLAW_SUPERVISOR_MODE: "external" },
      });
      vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
    }
    const respond = await requestUpdateRead(
      method,
      method === "update.runs.get" ? { runId: run.runId } : {},
    );
    if (kind === "refused") {
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining(
          method === "update.runs.get" ? { run } : { activeRun: run, lastRun: run },
        ),
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
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            [method === "update.status" ? "lastRun" : "run"]: expect.objectContaining(result),
          }),
        );
      }
    }
  });

  it("projects distinct active and latest runs and reads persisted history in creation order", async () => {
    expect(await requestUpdateRead("update.status")).toHaveBeenCalledWith(true, {
      sentinel: null,
      updateAvailable: null,
      effectiveChannel: "stable",
    });
    expect(await requestUpdateRead("update.runs.list")).toHaveBeenCalledWith(true, { runs: [] });

    const currentTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(currentTime - 2_000);
    const active = createUpdateRun({ trigger: "api" });
    now.mockReturnValue(currentTime - 1_000);
    const latest = finishUpdateRun(createUpdateRun({ trigger: "cli" }).runId, {
      status: "skipped",
      reason: "dry-run",
    });
    expect(await requestUpdateRead("update.status")).toHaveBeenCalledWith(true, {
      sentinel: null,
      activeRun: active,
      lastRun: latest,
      updateAvailable: null,
      effectiveChannel: "stable",
    });
    expect(
      await requestUpdateRead("update.runs.get", { runId: active.runId }),
    ).toHaveBeenCalledWith(true, { run: active });
    expect(
      await requestUpdateRead("update.runs.get", { runId: randomUUID() }),
    ).toHaveBeenCalledWith(true, { run: null });

    now.mockReturnValue(currentTime);
    const completed = finishUpdateRun(active.runId, { status: "succeeded" });
    expect(await requestUpdateRead("update.status")).toHaveBeenCalledWith(true, {
      sentinel: null,
      lastRun: latest,
      updateAvailable: null,
      effectiveChannel: "stable",
    });
    const nativeCalls = observeMainThreadSql();
    expect(await requestUpdateRead("update.runs.list")).toHaveBeenCalledWith(true, {
      runs: [latest, completed],
    });
    expect(await requestUpdateRead("update.runs.list", { limit: 1 })).toHaveBeenCalledWith(true, {
      runs: [latest],
    });
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
      const respond = await requestUpdateRead(method, params);
      expect(respond, `${method}: ${JSON.stringify(params)}`).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
  });
});

it("reconciles an expired legacy admission on Gateway watcher startup", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now - 25 * 60 * 60_000);
  const legacy = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
  clock.mockReturnValue(now);
  const published = createDeferredCore();
  const broadcast = vi.fn(() => published.resolve());
  const watcher = startUpdateRunWatcher({ lifecycle, broadcast, log: { warn: vi.fn() } });
  try {
    await published.promise;
    expect(getUpdateRun(legacy.runId)).toMatchObject({
      phase: "finished",
      status: "failed",
      reason: "legacy-driver-expired",
    });
    expect(broadcast).toHaveBeenCalledWith(
      "update.run.changed",
      expect.objectContaining({ runId: legacy.runId, status: "failed" }),
    );
  } finally {
    await watcher.stop();
  }
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

  const observed = createDeferredCore();
  const broadcast = vi.fn(() => observed.resolve());
  const log = {
    warn: vi.fn((message: string) => {
      // A failed discovery must reach the assertion, not wait for a test timeout.
      if (message.startsWith("update run watcher stopped:")) {
        observed.resolve();
      }
    }),
  };
  const watcher = startUpdateRunWatcher({ lifecycle, broadcast, log });
  try {
    await observed.promise;
    expect(broadcast).toHaveBeenCalledWith("update.run.changed", {
      runId: active.runId,
      phase: "requested",
      status: "running",
      updatedAtMs: active.updatedAtMs,
    });
    expect(lifecycle.scheduler.nextWakeAtMs).not.toBeNull();
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("update run watcher stopped:"),
    );
  } finally {
    await watcher.stop();
  }
});
