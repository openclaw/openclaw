import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { startUpdateRunWatcher } from "../update-run-watcher.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";
import { updateStatusHandlers } from "./update-status.js";

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateAvailable: () => null,
  getUpdateSchedule: () => null,
  getUpdateEffectiveChannel: async () => "stable",
  refreshGatewayUpdateStatus: async () => {},
}));

vi.mock("../server-restart-sentinel.js", () => ({
  getLatestUpdateRestartSentinel: () => null,
  refreshLatestUpdateRestartSentinel: async () => null,
}));

type UpdateReadMethod = "update.status" | "update.runs.get" | "update.runs.list";

const warn = vi.fn();
const logGateway: GatewayRequestContext["logGateway"] = {
  ...createSubsystemLogger("gateway-test"),
  warn,
};

async function requestUpdateRead(method: UpdateReadMethod, params: Record<string, unknown> = {}) {
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
      getRuntimeConfig: () => ({ update: { channel: "stable" } }),
      logGateway,
    } as GatewayRequestContext,
  });
  return respond;
}

let home: TempHomeEnv;
beforeEach(async () => {
  home = await createTempHomeEnv("openclaw-update-status-");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  warn.mockClear();
  await home.restore();
});

describe("update history RPCs", () => {
  it.each(["update.status", "update.runs.get"] as const)(
    "preserves readable history when reconciliation is refused through %s",
    async (method) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now - 25 * 60 * 60_000);
      const run = createUpdateRun({ trigger: "cli" });
      clock.mockReturnValue(now);
      claimOpenClawStateOwnership("test-supervisor", {
        env: { ...process.env, OPENCLAW_SUPERVISOR_MODE: "external" },
      });
      vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
      const respond = await requestUpdateRead(
        method,
        method === "update.runs.get" ? { runId: run.runId } : {},
      );
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
    },
  );

  it.each(["update.status", "update.runs.get"] as const)(
    "revalidates recorded dead drivers through %s",
    async (method) => {
      const driver = expectDefined(readUpdateRunDriver(), "local driver identity");
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now - 31 * 60_000);
      const run = createUpdateRun({
        trigger: "cli",
        origin: { driver: { ...driver, startIdentity: String(Number(driver.startIdentity) + 1) } },
      });
      clock.mockReturnValue(now);
      await requestUpdateRead(method, method === "update.runs.get" ? { runId: run.runId } : {});
      expect(getUpdateRun(run.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
    },
  );

  it.each(["update.status", "update.runs.get"] as const)(
    "reconciles expired legacy admission before %s reaches the UI",
    async (method) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now - 25 * 60 * 60_000);
      const legacy = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
      clock.mockReturnValue(now);
      const respond = await requestUpdateRead(
        method,
        method === "update.runs.get" ? { runId: legacy.runId } : {},
      );
      expect(getUpdateRun(legacy.runId)).toMatchObject({
        phase: "finished",
        status: "failed",
        reason: "legacy-driver-expired",
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          [method === "update.status" ? "lastRun" : "run"]: expect.objectContaining({
            status: "failed",
            reason: "legacy-driver-expired",
          }),
        }),
      );
    },
  );

  it("projects distinct active and latest runs and reads persisted history in creation order", async () => {
    expect(await requestUpdateRead("update.status")).toHaveBeenCalledWith(true, {
      sentinel: null,
      updateAvailable: null,
      effectiveChannel: "stable",
    });
    expect(await requestUpdateRead("update.runs.list")).toHaveBeenCalledWith(true, { runs: [] });

    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const active = createUpdateRun({ trigger: "api" });
    now.mockReturnValue(2_000);
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

    now.mockReturnValue(3_000);
    const completed = finishUpdateRun(active.runId, { status: "succeeded" });
    expect(await requestUpdateRead("update.status")).toHaveBeenCalledWith(true, {
      sentinel: null,
      lastRun: latest,
      updateAvailable: null,
      effectiveChannel: "stable",
    });
    expect(await requestUpdateRead("update.runs.list")).toHaveBeenCalledWith(true, {
      runs: [latest, completed],
    });
    expect(await requestUpdateRead("update.runs.list", { limit: 1 })).toHaveBeenCalledWith(true, {
      runs: [latest],
    });
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
  const broadcast = vi.fn();
  const watcher = startUpdateRunWatcher({ broadcast, log: { warn: vi.fn() } });
  try {
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
