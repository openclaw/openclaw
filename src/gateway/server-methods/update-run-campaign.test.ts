// update.run campaign tests cover failure release and concurrent campaign ownership.
import "../../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import type { UpdateCampaignController } from "../../infra/update-campaign.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "../../infra/update-check-lifecycle.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import type { RespondFn } from "./types.js";

let ledgerHome: TempHomeEnv | undefined;
let lifecycle: UpdateCheckLifecycle;
beforeEach(async () => {
  ledgerHome = await createTempHomeEnv("openclaw-update-campaign-rpc-");
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
});
afterEach(async () => {
  await lifecycle.stop();
  await ledgerHome?.restore();
  ledgerHome = undefined;
});

let currentCampaignId: string | undefined;
let updateChannel: "stable" | "beta" | "dev" | null;
const sentinelAdmission = vi.hoisted((): { beforeGrant?: (stage: string) => void } => ({}));
type UpdateCampaignAdoption = ReturnType<UpdateCampaignController["adopt"]>;

const adoptCampaignMock = vi.fn<() => UpdateCampaignAdoption>();
const clearCampaignMock = vi.fn();
const getCampaignStateMock = vi.fn(() =>
  currentCampaignId
    ? {
        id: currentCampaignId,
        state: "applying" as const,
        announcedAtMs: 1,
        forceAtMs: 2,
        updatedAtMs: 1,
      }
    : undefined,
);

const resolveUpdateInstallSurfaceMock =
  vi.fn<
    typeof import("../../infra/update-runner-install-surface.js").resolveUpdateInstallSurface
  >();
const resolveStartupInstallStatusMock =
  vi.fn<typeof import("../../infra/update-install-status.js").resolveStartupInstallStatus>();
const detectRespawnSupervisorMock = vi.fn<() => RespawnSupervisor | null>();
const startManagedServiceUpdateHandoffMock =
  vi.fn<
    typeof import("../../infra/update-managed-service-handoff.js").startManagedServiceUpdateHandoff
  >();
const transferManagedServiceUpdateHandoffMock = vi.fn<
  typeof import("../../infra/update-managed-service-handoff.js").transferManagedServiceUpdateHandoff
>(async () => true);
const cancelManagedServiceUpdateHandoffMock = vi.fn<
  typeof import("../../infra/update-managed-service-handoff.js").cancelManagedServiceUpdateHandoff
>(async () => "restored-in-process");
const scheduleGatewayRestartMock = vi.fn(() => ({ scheduled: true }));
const writeRestartSentinelMock = vi.fn<
  (
    ...args: Parameters<typeof import("../../infra/restart-sentinel.js").writeRestartSentinel>
  ) => Promise<unknown>
>(async () => undefined);
const recordLatestUpdateRestartSentinelMock = vi.fn();

vi.mock("../../config/commands.flags.js", () => ({ isRestartEnabled: () => true }));
vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: async () => ({ valid: false }),
}));
vi.mock("../../config/sessions.js", () => ({ extractDeliveryInfo: () => ({}) }));

vi.mock("../../infra/gateway-supervision.js", () => ({
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON: "external-supervisor-update-required",
  isGatewayExternallySupervised: () => false,
}));

vi.mock("../../infra/package-json.js", () => ({ readPackageVersion: async () => "1.0.0" }));

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
    "../../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    writeRestartSentinel: writeRestartSentinelMock,
  };
});

vi.mock("../../infra/sqlite-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/sqlite-worker-store.js")>();
  return {
    ...actual,
    createSqliteWorkerWriteAdmission: (
      assertCurrent: Parameters<typeof actual.createSqliteWorkerWriteAdmission>[0],
      nativeLocations: readonly string[],
    ) =>
      actual.createSqliteWorkerWriteAdmission((request) => {
        sentinelAdmission.beforeGrant?.(request.stage);
        assertCurrent(request);
      }, nativeLocations),
  };
});

vi.mock("../../infra/restart.js", async () => ({
  ...(await vi.importActual<typeof import("../../infra/restart.js")>("../../infra/restart.js")),
  scheduleGatewayRestart: scheduleGatewayRestartMock,
}));

vi.mock("../../infra/supervisor-markers.js", () => ({
  detectRespawnSupervisor: detectRespawnSupervisorMock,
}));

vi.mock("../../daemon/gateway-entrypoint.js", async (original) => ({
  ...(await original<typeof import("../../daemon/gateway-entrypoint.js")>()),
  resolveGatewayInstallEntrypoint: async (root: string) => `${root}/dist/index.js`,
}));

vi.mock("../../infra/gateway-owner-lease.js", () => ({
  readGatewayOwnerLease: () =>
    detectRespawnSupervisorMock.mock.results.at(-1)?.value
      ? undefined
      : {
          owner: "foreground-owner",
          pid: process.pid,
          host: "fixture-host",
          startedAt: 1,
          port: 18789,
          mode: "foreground",
          state: "live",
          expired: false,
          supervisor: null,
        },
}));

vi.mock("../../infra/update-check-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/update-check-lifecycle.js")>();
  return {
    ...actual,
    currentUpdateCheckLifecycle: () => ({
      ...actual.currentUpdateCheckLifecycle(),
      campaign: {
        adopt: adoptCampaignMock,
        clear: clearCampaignMock,
        getState: getCampaignStateMock,
        bindRun: vi.fn(),
      },
    }),
  };
});

vi.mock("../../infra/update-channels.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/update-channels.js")>(
    "../../infra/update-channels.js",
  );
  return { ...actual, normalizeUpdateChannel: () => updateChannel };
});

vi.mock("../../infra/update-managed-service-handoff.js", () => ({
  claimManagedServiceUpdateHandoff: () => true,
  startManagedServiceUpdateHandoff: startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoff: transferManagedServiceUpdateHandoffMock,
  cancelManagedServiceUpdateHandoff: cancelManagedServiceUpdateHandoffMock,
}));

vi.mock("../../infra/update-runner-install-surface.js", () => ({
  resolveUpdateInstallSurface: resolveUpdateInstallSurfaceMock,
}));

vi.mock("../../infra/update-status-state.js", () => ({
  getUpdateAvailable: () => null,
  getUpdateSchedule: () => null,
}));

vi.mock("../../infra/update-install-status.js", () => ({
  resolveStartupInstallStatus: resolveStartupInstallStatusMock,
}));

vi.mock("../../version.js", () => ({ VERSION: "1.0.0" }));

vi.mock("../server-update-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-update-sentinel.js")>()),
  getLatestUpdateRestartSentinel: () => null,
  recordLatestUpdateRestartSentinel: recordLatestUpdateRestartSentinelMock,
  prepareLatestUpdateRestartSentinel: async () => null,
}));

vi.mock("./restart-request.js", () => ({ parseRestartRequestParams: () => ({}) }));

beforeEach(() => {
  currentCampaignId = "campaign-1";
  updateChannel = null;
  adoptCampaignMock.mockReset();
  adoptCampaignMock.mockReturnValue({
    status: "adopted",
    campaignId: "campaign-1",
    target: { kind: "package", version: "2.0.0" },
  });
  clearCampaignMock.mockClear();
  getCampaignStateMock.mockClear();
  startManagedServiceUpdateHandoffMock.mockReset().mockImplementation(async (params) => ({
    status: "started",
    pid: 12345,
    command: "openclaw update --yes --timeout 1800",
    logPath: "/tmp/fixture.log",
    handoffId: "handoff-1",
    installRoot: params.root,
  }));
  resolveUpdateInstallSurfaceMock.mockReset();
  resolveUpdateInstallSurfaceMock.mockResolvedValue({
    kind: "git",
    mode: "git",
    root: "/tmp/openclaw",
    packageRoot: "/tmp/openclaw",
  });
  resolveStartupInstallStatusMock.mockReset();
  resolveStartupInstallStatusMock.mockResolvedValue({
    root: "/tmp/openclaw",
    status: { root: "/tmp/openclaw", installKind: "git", packageManager: "pnpm" },
    installReceipt: null,
  });
  detectRespawnSupervisorMock.mockReset();
  detectRespawnSupervisorMock.mockReturnValue(null);
  startManagedServiceUpdateHandoffMock.mockClear();
  transferManagedServiceUpdateHandoffMock.mockReset().mockResolvedValue(true);
  cancelManagedServiceUpdateHandoffMock.mockReset().mockResolvedValue("restored-in-process");
  scheduleGatewayRestartMock.mockClear();
  writeRestartSentinelMock.mockClear();
  recordLatestUpdateRestartSentinelMock.mockClear();
});

function adoptDevCampaign(upstreamSha = "frozen-upstream-sha"): void {
  updateChannel = "dev";
  const target = {
    kind: "git",
    upstreamRef: "origin/main",
    upstreamSha,
    commitsBehind: 3,
  } as const;
  adoptCampaignMock.mockReturnValue({
    status: "adopted",
    campaignId: "campaign-1",
    target,
  });
}

function mockGitInstallStatus(upstreamSha: string, upstreamRef = "origin/main"): void {
  const root = "/tmp/openclaw";
  resolveStartupInstallStatusMock.mockResolvedValueOnce({
    root,
    status: {
      root,
      installKind: "git",
      packageManager: "pnpm",
      git: {
        root,
        sha: "0".repeat(40),
        tag: null,
        branch: "main",
        upstream: upstreamRef,
        upstreamSha,
        dirty: false,
        ahead: 0,
        behind: 1,
        fetchOk: true,
      },
    },
    installReceipt: null,
  });
}

function mockPackageInstallSurface(): void {
  const root = "/tmp/openclaw";
  resolveStartupInstallStatusMock.mockResolvedValueOnce({
    root,
    status: { root, installKind: "package", packageManager: "npm" },
    installReceipt: null,
  });
  resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({
    kind: "global",
    mode: "npm",
    root,
    packageRoot: root,
  });
}

async function invokeUpdateRun(
  params: Record<string, unknown> = {},
  respond: RespondFn = () => undefined,
): Promise<void> {
  const { updateHandlers } = await import("./update.js");
  await expectDefined(
    updateHandlers["update.run"],
    'updateHandlers["update.run"] test invariant',
  )({
    params,
    respond,
    client: {
      connId: "conn-1",
      clientIp: "127.0.0.1",
      connect: { client: { id: "control-ui" }, device: { id: "device-1" } },
    },
    context: {
      getRuntimeConfig: () => ({ update: {} }) as OpenClawConfig,
      logGateway: { info: vi.fn(), warn: vi.fn() },
    },
  } as never);
}

async function captureUpdateRun(params: Record<string, unknown>) {
  let response: { ok?: boolean; result?: { status?: string; reason?: string } } | undefined;
  await invokeUpdateRun(params, (_ok, payload) => {
    response = payload as typeof response;
  });
  return response;
}

function expectNoUpdateMutation(): void {
  expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  expect(writeRestartSentinelMock).not.toHaveBeenCalled();
  expect(recordLatestUpdateRestartSentinelMock).not.toHaveBeenCalled();
}

function expectHandoff(properties: Record<string, unknown>): void {
  expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
    expect.objectContaining(properties),
  );
}

describe("update.run campaign ownership", () => {
  it.each([null, "launchd"] as const)(
    "pins and retains a package campaign through supervisor=%s handoff",
    async (supervisor) => {
      const sentinel = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
        "../../infra/restart-sentinel.js",
      );
      if (!supervisor) {
        writeRestartSentinelMock.mockImplementationOnce(sentinel.writeRestartSentinel);
      }
      updateChannel = "beta";
      detectRespawnSupervisorMock.mockReturnValueOnce(supervisor);
      mockPackageInstallSurface();
      await withEnvAsync(
        { OPENCLAW_LAUNCHD_LABEL: supervisor ? "ai.openclaw.gateway" : undefined },
        invokeUpdateRun,
      );
      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ channel: "beta", tag: "2.0.0" }),
      );
      expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledExactlyOnceWith({
        kind: "managed-update-handoff",
        handoffId: "handoff-1",
        installRoot: "/tmp/openclaw",
      });
      expect(cancelManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
      expect(clearCampaignMock).not.toHaveBeenCalled();
      if (!supervisor) {
        await expect(sentinel.readRestartSentinel()).resolves.toMatchObject({
          payload: { kind: "update", stats: { handoffId: "handoff-1" } },
        });
      }
    },
  );

  it("keeps a plain package update on the moving configured channel", async () => {
    updateChannel = "beta";
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });
    mockPackageInstallSurface();

    await invokeUpdateRun();

    expectHandoff({ channel: "beta" });
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ tag: expect.anything() }),
    );
  });

  it("uses the prepared Git checkout instead of process artifacts", async () => {
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });
    resolveStartupInstallStatusMock.mockResolvedValueOnce({
      root: "/tmp/openclaw-source",
      status: {
        root: "/tmp/openclaw-source",
        installKind: "git",
        packageManager: "pnpm",
      },
      installReceipt: null,
    });
    resolveUpdateInstallSurfaceMock.mockImplementationOnce(async ({ root, installKind }) =>
      root === "/tmp/openclaw-source" && installKind === "git"
        ? { kind: "git", mode: "git", root, packageRoot: root }
        : {
            kind: "global",
            mode: "npm",
            root: "/tmp/openclaw-launcher-package",
            packageRoot: "/tmp/openclaw-launcher-package",
          },
    );

    await invokeUpdateRun();

    expectHandoff({ root: "/tmp/openclaw-source", argv1: "/tmp/openclaw-source/dist/index.js" });
  });

  it("rejects a missing prepared root without scanning the process working directory", async () => {
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });
    resolveStartupInstallStatusMock.mockResolvedValueOnce({
      root: null,
      status: { root: null, installKind: "unknown", packageManager: "unknown" },
      installReceipt: null,
    });
    resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({ kind: "missing", mode: "unknown" });

    await invokeUpdateRun();

    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  });

  it("rejects an explicit commit that conflicts with the adopted Git campaign before mutation", async () => {
    const campaignSha = "1234567890abcdef1234567890abcdef12345678";
    adoptDevCampaign(campaignSha);
    mockGitInstallStatus(campaignSha);
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    adoptCampaignMock.mockReturnValueOnce({ status: "mismatch" });

    const response = await captureUpdateRun({
      target: {
        kind: "git",
        upstreamRef: "origin/main",
        upstreamSha: "abcdef1234567890abcdef1234567890abcdef12",
      },
    });

    expect(response?.result).toMatchObject({
      status: "error",
      reason: "update-target-campaign-mismatch",
    });
    expectNoUpdateMutation();
    expect(clearCampaignMock).not.toHaveBeenCalled();

    await invokeUpdateRun();

    expect(adoptCampaignMock).toHaveBeenCalledTimes(2);
    expectHandoff({
      devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: campaignSha },
    });
  });

  describe("explicit Git target binding", () => {
    const requestTarget = {
      kind: "git",
      upstreamRef: "origin/main",
      upstreamSha: "1234567890abcdef1234567890abcdef12345678",
    };
    const newerUpstreamSha = "abcdef1234567890abcdef1234567890abcdef12";
    const trackedTarget = {
      mode: "tracked",
      upstreamRef: requestTarget.upstreamRef,
      upstreamSha: requestTarget.upstreamSha,
    };

    beforeEach(() => {
      updateChannel = "dev";
      adoptCampaignMock.mockReturnValue({ status: "absent" });
    });

    it.each([false, true])(
      "rejects an applying campaign (explicit target: %s)",
      async (explicit) => {
        adoptDevCampaign(explicit ? newerUpstreamSha : undefined);
        if (explicit) {
          mockGitInstallStatus(newerUpstreamSha);
          detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
        }
        adoptCampaignMock.mockReturnValueOnce({ status: "applying" });

        const response = await captureUpdateRun(explicit ? { target: requestTarget } : {});

        expect(response).toMatchObject({
          ok: false,
          result: { status: "error", reason: "update-campaign-applying" },
        });
        expect(adoptCampaignMock).toHaveBeenCalledWith(explicit ? trackedTarget : undefined);
        expectNoUpdateMutation();
        expect(getCampaignStateMock).not.toHaveBeenCalled();
        expect(clearCampaignMock).not.toHaveBeenCalled();
      },
    );

    it.each([null, "launchd"] as const)(
      "keeps the requested commit after upstream advances (supervisor=%s)",
      async (supervisor) => {
        detectRespawnSupervisorMock.mockReturnValueOnce(supervisor);
        mockGitInstallStatus(newerUpstreamSha);
        const response = await captureUpdateRun({ target: requestTarget });
        expectHandoff({ devTarget: trackedTarget });
        expect(response?.ok).toBe(true);
      },
    );

    it.each([
      { name: "short SHA", target: { ...requestTarget, upstreamSha: "1234567" } },
      { name: "nonhex SHA", target: { ...requestTarget, upstreamSha: "g".repeat(40) } },
      { name: "unsafe upstream", target: { ...requestTarget, upstreamRef: "origin/main branch" } },
      { name: "wrong kind", target: { ...requestTarget, kind: "package" } },
      { name: "non-object", target: "origin/main" },
    ])("rejects malformed $name before any update mutation", async ({ target }) => {
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");

      const respond = vi.fn();
      await invokeUpdateRun({ target }, respond);

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("invalid update.run params:"),
        }),
      );
      expectNoUpdateMutation();
      expect(adoptCampaignMock).not.toHaveBeenCalled();
    });

    it.each(["another upstream", "stable channel", "package install"] as const)(
      "rejects an exact Git target for %s before update mutation",
      async (scenario) => {
        detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
        if (scenario === "package install") {
          mockPackageInstallSurface();
        } else {
          updateChannel = scenario === "stable channel" ? "stable" : "dev";
          mockGitInstallStatus(
            newerUpstreamSha,
            scenario === "another upstream" ? "upstream/main" : "origin/main",
          );
        }
        const response = await captureUpdateRun({ target: requestTarget });
        expect(response?.result).toMatchObject({
          status: "error",
          reason:
            scenario === "another upstream"
              ? "update-target-upstream-mismatch"
              : "unsupported-update-target",
        });
        expectNoUpdateMutation();
        expect(adoptCampaignMock).not.toHaveBeenCalled();
      },
    );
  });

  it("records handoff preparation failure before ending the adopted campaign", async () => {
    startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(new Error("entrypoint unavailable"));
    let outcomeWhenCampaignEnded: unknown;
    clearCampaignMock.mockImplementationOnce(() => {
      outcomeWhenCampaignEnded = recordLatestUpdateRestartSentinelMock.mock.calls.at(-1)?.[0];
    });
    await invokeUpdateRun();

    expect(adoptCampaignMock).toHaveBeenCalledOnce();
    expect(clearCampaignMock).toHaveBeenCalledOnce();
    expect(outcomeWhenCampaignEnded).toMatchObject({
      kind: "update",
      status: "error",
      stats: { reason: "managed-service-handoff-failed" },
    });
  });

  it("continues without an explicit target when no campaign can be adopted", async () => {
    adoptDevCampaign();
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });

    await invokeUpdateRun();

    expect(getCampaignStateMock).not.toHaveBeenCalled();
    expect(clearCampaignMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ devTarget: expect.anything() }),
    );
  });

  it("does not clear a replacement campaign when the adopted update fails", async () => {
    const deferredUpdate =
      createDeferred<Awaited<ReturnType<typeof startManagedServiceUpdateHandoffMock>>>();
    const handoffStarted = createDeferred();
    startManagedServiceUpdateHandoffMock.mockImplementationOnce(() => {
      handoffStarted.resolve();
      return deferredUpdate.promise;
    });
    const updateRun = invokeUpdateRun();
    try {
      await awaitGateBeforeSettlement(
        handoffStarted.promise,
        updateRun,
        "update.run settled before starting its managed handoff",
      );
      expect(adoptCampaignMock).toHaveBeenCalledOnce();
      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      expect(getCampaignStateMock).not.toHaveBeenCalled();
      currentCampaignId = "campaign-2";
    } finally {
      deferredUpdate.reject(new Error("entrypoint unavailable"));
      await updateRun;
    }

    expect(getCampaignStateMock).toHaveBeenCalledOnce();
    expect(clearCampaignMock).not.toHaveBeenCalled();
    expect(writeRestartSentinelMock).not.toHaveBeenCalled();
    expect(recordLatestUpdateRestartSentinelMock).not.toHaveBeenCalled();
  });

  it.each(["transaction", "commit"] as const)(
    "preserves the durable sentinel when its campaign retires at %s admission",
    async (stage) => {
      const sentinel = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
        "../../infra/restart-sentinel.js",
      );
      const existing = await sentinel.writeRestartSentinel({
        kind: "restart",
        status: "ok",
        ts: 1,
        message: "Existing notification",
      });
      startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(
        new Error("entrypoint unavailable"),
      );
      writeRestartSentinelMock.mockImplementationOnce(sentinel.writeRestartSentinel);
      const observed: string[] = [];
      sentinelAdmission.beforeGrant = (requested) => {
        observed.push(requested);
        if (requested === stage) {
          currentCampaignId = "campaign-2";
        }
      };
      try {
        await invokeUpdateRun();
      } finally {
        sentinelAdmission.beforeGrant = undefined;
      }
      expect(observed).toContain(stage);
      await expect(sentinel.readRestartSentinel()).resolves.toEqual(existing);
      expect(recordLatestUpdateRestartSentinelMock).not.toHaveBeenCalled();
      expect(clearCampaignMock).not.toHaveBeenCalled();
    },
  );
});
