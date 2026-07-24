// Tests for the process-wide single-flight guard on update.run that
// prevents concurrent update execution across managed-handoff and direct
// in-process update paths.  Mocks are local to this file; the guard is
// a module-level state tested in isolation.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { withEnvAsync } from "../../test-utils/env.js";

const runGatewayUpdateMock = vi.fn<() => Promise<UpdateRunResult>>();
type UpdateInstallSurface = Awaited<
  ReturnType<typeof import("../../infra/update-runner.js").resolveUpdateInstallSurface>
>;
const resolveUpdateInstallSurfaceMock = vi.fn<() => Promise<UpdateInstallSurface>>(async () => ({
  kind: "git",
  mode: "git",
  root: "/tmp/openclaw",
  packageRoot: "/tmp/openclaw",
}));
const getLatestUpdateRestartSentinelMock = vi.fn<() => RestartSentinelPayload | null>(() => null);
const refreshLatestUpdateRestartSentinelMock = vi.fn<() => Promise<RestartSentinelPayload | null>>(
  async () => null,
);
const recordLatestUpdateRestartSentinelMock = vi.fn();
const isRestartEnabledMock = vi.fn(() => true);
const readPackageVersionMock = vi.fn(async () => "1.0.0");
const detectRespawnSupervisorMock = vi.fn<() => RespawnSupervisor | null>(() => null);
const normalizeUpdateChannelMock = vi.fn((): UpdateChannel | null => null);
const readConfigFileSnapshotMock = vi.fn<() => Promise<ConfigFileSnapshot>>();
type ManagedServiceUpdateHandoffResult = Awaited<
  ReturnType<
    typeof import("../../infra/update-managed-service-handoff.js").startManagedServiceUpdateHandoff
  >
>;
const startManagedServiceUpdateHandoffMock = vi.fn<
  (params?: { handoffId?: string }) => Promise<ManagedServiceUpdateHandoffResult>
>(async (params) => ({
  status: "started",
  pid: 12345,
  command: "openclaw update --yes --timeout 1800",
  logPath: "/tmp/openclaw-update-run-handoff/handoff.log",
  handoffId: params?.handoffId,
}));

const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({ scheduled: true }));

type PostCoreFinalizeOutcome = Awaited<
  ReturnType<
    typeof import("../../infra/update-post-core-finalize.js").runPostCoreFinalizeAfterGatewayUpdate
  >
>;
const runPostCoreFinalizeAfterGatewayUpdateMock = vi.fn<() => Promise<PostCoreFinalizeOutcome>>(
  async () => ({ status: "skipped", reason: "not-git-update" }),
);

type UpdateRunPayload = {
  ok: boolean;
  result?: { status?: string; reason?: string; mode?: string };
  handoff?: { status?: string; command?: string; message?: string };
  sentinel?: { persisted?: boolean };
  restart?: unknown;
};

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({ update: {} }),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

vi.mock("../../config/commands.flags.js", () => ({
  isRestartEnabled: isRestartEnabledMock,
}));

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: (sessionKey: string | undefined) => {
    if (!sessionKey) {
      return { deliveryContext: undefined, threadId: undefined };
    }
    return {
      deliveryContext: { channel: "webchat", to: "webchat:user-123", accountId: "default" },
      threadId: undefined,
    };
  },
}));

vi.mock("../../infra/openclaw-root.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/openclaw-root.js")>(
    "../../infra/openclaw-root.js",
  );
  return {
    ...actual,
    resolveOpenClawPackageRoot: async () => "/tmp/openclaw",
  };
});

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual("../../infra/restart-sentinel.js");
  return {
    ...(actual as Record<string, unknown>),
    writeRestartSentinel: async () => {},
  };
});

vi.mock("../../infra/restart.js", () => ({
  resolveGatewayRestartDeferralTimeoutMs: (timeoutMs: unknown) => {
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
      return 300_000;
    }
    return timeoutMs <= 0 ? undefined : Math.floor(timeoutMs);
  },
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

vi.mock("../../infra/package-json.js", () => ({
  readPackageVersion: readPackageVersionMock,
}));

vi.mock("../../infra/supervisor-markers.js", () => ({
  detectRespawnSupervisor: detectRespawnSupervisorMock,
}));

vi.mock("../../infra/update-channels.js", () => ({
  normalizeUpdateChannel: normalizeUpdateChannelMock,
}));

vi.mock("../../infra/update-runner.js", () => ({
  resolveUpdateInstallSurface: resolveUpdateInstallSurfaceMock,
  runGatewayUpdate: runGatewayUpdateMock,
}));

vi.mock("../../infra/update-post-core-finalize.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/update-post-core-finalize.js")>(
    "../../infra/update-post-core-finalize.js",
  );
  return {
    ...actual,
    runPostCoreFinalizeAfterGatewayUpdate: runPostCoreFinalizeAfterGatewayUpdateMock,
  };
});

vi.mock("../../../packages/gateway-protocol/src/index.js", () => ({
  validateUpdateStatusParams: () => true,
  validateUpdateRunParams: () => true,
}));

vi.mock("../server-restart-sentinel.js", () => ({
  getLatestUpdateRestartSentinel: getLatestUpdateRestartSentinelMock,
  recordLatestUpdateRestartSentinel: recordLatestUpdateRestartSentinelMock,
  refreshLatestUpdateRestartSentinel: refreshLatestUpdateRestartSentinelMock,
}));

vi.mock("./restart-request.js", () => ({
  parseRestartRequestParams: (params: Record<string, unknown>) => ({
    sessionKey: params.sessionKey,
    note: params.note,
    continuationMessage: params.continuationMessage,
    restartDelayMs: params.restartDelayMs,
  }),
}));

vi.mock("../../infra/update-managed-service-handoff.js", () => ({
  startManagedServiceUpdateHandoff: startManagedServiceUpdateHandoffMock,
  formatManagedServiceUpdateCommand: (params?: { timeoutMs?: number; channel?: UpdateChannel }) => {
    const args = ["openclaw", "update", "--yes"];
    if (params?.channel) {
      args.push("--channel", params.channel);
    }
    if (params?.timeoutMs) {
      args.push("--timeout", String(Math.ceil(params.timeoutMs / 1000)));
    }
    return args.join(" ");
  },
  buildManagedServiceHandoffUnavailableMessage: (command: string) =>
    [
      "OpenClaw updates cannot safely run inside the live gateway process without a managed-service handoff.",
      `Run \`${command}\` from a shell outside the gateway service, or restart/update from the host UI.`,
    ].join("\n"),
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

beforeEach(() => {
  isRestartEnabledMock.mockReset();
  isRestartEnabledMock.mockReturnValue(true);
  readPackageVersionMock.mockClear();
  readPackageVersionMock.mockResolvedValue("1.0.0");
  normalizeUpdateChannelMock.mockReset();
  normalizeUpdateChannelMock.mockReturnValue(null);
  readConfigFileSnapshotMock.mockReset();
  readConfigFileSnapshotMock.mockResolvedValue({
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: {} as OpenClawConfig,
    sourceConfig: {} as OpenClawConfig,
    valid: true,
    config: {} as OpenClawConfig,
    runtimeConfig: {} as OpenClawConfig,
    issues: [],
    warnings: [],
    legacyIssues: [],
  });
  detectRespawnSupervisorMock.mockReset();
  detectRespawnSupervisorMock.mockReturnValue(null);
  runGatewayUpdateMock.mockClear();
  runGatewayUpdateMock.mockResolvedValue({
    status: "ok",
    mode: "npm",
    after: { version: "2.0.0" },
    steps: [],
    durationMs: 100,
  });
  resolveUpdateInstallSurfaceMock.mockClear();
  resolveUpdateInstallSurfaceMock.mockResolvedValue({
    kind: "git",
    mode: "git",
    root: "/tmp/openclaw",
    packageRoot: "/tmp/openclaw",
  });
  getLatestUpdateRestartSentinelMock.mockClear();
  refreshLatestUpdateRestartSentinelMock.mockClear();
  refreshLatestUpdateRestartSentinelMock.mockResolvedValue(null);
  recordLatestUpdateRestartSentinelMock.mockClear();
  startManagedServiceUpdateHandoffMock.mockClear();
  startManagedServiceUpdateHandoffMock.mockImplementation(
    async (params?: { handoffId?: string }) => ({
      status: "started" as const,
      pid: 12345,
      command: "openclaw update --yes --timeout 1800",
      logPath: "/tmp/openclaw-update-run-handoff/handoff.log",
      handoffId: params?.handoffId,
    }),
  );
  scheduleGatewaySigusr1RestartMock.mockClear();
  scheduleGatewaySigusr1RestartMock.mockReturnValue({ scheduled: true });
  runPostCoreFinalizeAfterGatewayUpdateMock.mockClear();
  runPostCoreFinalizeAfterGatewayUpdateMock.mockResolvedValue({
    status: "skipped",
    reason: "not-git-update",
  });
});

async function invokeUpdateRun(
  params: Record<string, unknown>,
  respond?: (ok: boolean, response?: unknown) => void,
  runtimeConfig: OpenClawConfig = { update: {} },
) {
  const { updateHandlers } = await import("./update.js");
  const onRespond = respond ?? (() => {});
  await expectDefined(
    updateHandlers["update.run"],
    'updateHandlers["update.run"] test invariant',
  )({
    params,
    respond: onRespond as never,
    context: { getRuntimeConfig: () => runtimeConfig },
  } as never);
}

async function captureUpdateRunPayload(
  params: Record<string, unknown> = {},
  runtimeConfig?: OpenClawConfig,
): Promise<UpdateRunPayload | undefined> {
  let payload: UpdateRunPayload | undefined;
  await invokeUpdateRun(
    params,
    (_ok: boolean, response: unknown) => {
      payload = response as UpdateRunPayload;
    },
    runtimeConfig,
  );
  return payload;
}

async function withProcessEnv<T>(
  updates: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  return await withEnvAsync(updates, run);
}

function mockGlobalInstallSurface() {
  resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({
    kind: "global",
    mode: "npm",
    root: "/tmp/openclaw-global",
    packageRoot: "/tmp/openclaw-global",
  });
}

describe("update.run single-flight guard", () => {
  it("rejects a concurrent update.run call while another is in flight", async () => {
    // Use the default (git, no supervisor) path so the handler reaches the
    // direct in-process update branch — no managed handoff involved.
    const payload1Promise = captureUpdateRunPayload();
    const payload2 = await captureUpdateRunPayload();

    expect(payload2?.ok).toBe(false);
    expect(payload2?.result).toMatchObject({
      status: "skipped",
      reason: "update-already-in-progress",
    });
    expect(payload2?.handoff).toMatchObject({
      status: "already-running",
    });

    // The first request should still complete normally.
    const payload1 = await payload1Promise;
    expect(payload1?.ok).toBe(true);
    expect(runGatewayUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("releases the guard after a successful update so the next call can proceed", async () => {
    const first = await captureUpdateRunPayload();
    expect(first?.ok).toBe(true);

    const second = await captureUpdateRunPayload();
    expect(second?.ok).toBe(true);
    expect(runGatewayUpdateMock).toHaveBeenCalledTimes(2);
  });

  it("releases the guard after an update error so the next call can proceed", async () => {
    runGatewayUpdateMock.mockRejectedValueOnce(new Error("spawn ENOENT"));

    const first = await captureUpdateRunPayload();
    expect(first?.ok).toBe(false);
    expect(first?.result).toMatchObject({
      status: "error",
    });

    runGatewayUpdateMock.mockResolvedValueOnce({
      status: "ok",
      mode: "npm",
      after: { version: "3.0.0" },
      steps: [],
      durationMs: 100,
    });

    const second = await captureUpdateRunPayload();
    expect(second?.ok).toBe(true);
    expect(runGatewayUpdateMock).toHaveBeenCalledTimes(2);
  });

  it("protects the managed-handoff path against concurrent update.run calls", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();

    // Make the handoff mock stay pending so the first request yields inside
    // the guarded region, giving the second request a chance to observe the
    // in-flight state.
    let resolveHandoff: (value: ManagedServiceUpdateHandoffResult) => void;
    const handoffDeferred = new Promise<ManagedServiceUpdateHandoffResult>((resolve) => {
      resolveHandoff = resolve;
    });
    startManagedServiceUpdateHandoffMock.mockReturnValueOnce(handoffDeferred);

    const firstPayloadPromise = withProcessEnv(
      { OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" },
      () => captureUpdateRunPayload(),
    );

    // The second request must be rejected because the guard is already set
    // by the first request (before it entered its first await).
    const secondPayload = await withProcessEnv(
      { OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" },
      () => captureUpdateRunPayload(),
    );
    expect(secondPayload?.ok).toBe(false);
    expect(secondPayload?.result?.reason).toBe("update-already-in-progress");

    // Resolve the first request so it can complete.
    resolveHandoff!({
      status: "started",
      pid: 12345,
      command: "openclaw update --yes --timeout 1800",
      logPath: "/tmp/openclaw-update-run-handoff/handoff.log",
      handoffId: "handoff-test",
    });
    const firstPayload = await firstPayloadPromise;
    expect(firstPayload?.ok).toBe(true);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
  });
});
