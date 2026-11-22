import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import {
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import {
  sentinelState,
  withTransferredUpdateHandoff,
  isRestartEnabledMock,
  detectRespawnSupervisorMock as detectSupervisor,
  normalizeUpdateChannelMock,
  getUpdateAvailableMock,
  adoptUpdateCampaignMock,
  startManagedServiceUpdateHandoffMock as startHandoff,
  transferManagedServiceUpdateHandoffMock as transferHandoff,
  sendGatewayLifecycleNoticeMock as sendNotice,
  scheduleGatewayRestartMock as scheduleRestart,
  resolveGatewayLifecycleNoticeRouteMock as resolveNoticeRoute,
  readGatewayOwnerLeaseAsyncMock,
  invokeUpdateRun,
  captureUpdateRunPayload,
  mockGlobalInstallSurface,
} from "./update.test-harness.js";

const restarting = "⏳ Preparing to restart OpenClaw… The update is not complete yet.";

function expectHandoff(fields: Record<string, unknown>) {
  expect(startHandoff).toHaveBeenCalledWith(expect.objectContaining(fields));
}

function expectServingHandoff(payload: unknown, fields: Record<string, unknown>) {
  expectHandoff(fields);
  expect(startHandoff).toHaveBeenCalledOnce();
  expect(transferHandoff).toHaveBeenCalledOnce();
  expect(scheduleRestart).not.toHaveBeenCalled();
  expect(payload).toMatchObject({ ok: true, restart: null });
}

function managedPackage() {
  mockGlobalInstallSurface();
  detectSupervisor.mockReturnValue("launchd");
  getUpdateAvailableMock.mockReturnValue({
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    channel: "stable",
  });
}

function deferNotice() {
  const delivered = createDeferredCore<boolean>();
  const started = createDeferredCore();
  sendNotice.mockImplementationOnce(() => {
    started.resolve();
    return delivered.promise;
  });
  return { delivered, started };
}

async function internalSession(sessionId: string) {
  const sessionKey = "agent:main:webchat:lane";
  const storePath = resolveDefaultSessionStorePath("main");
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey, storePath },
    { sessionId, updatedAt: 1, delivery: { kind: "internal" } },
  );
  const { extractDeliveryInfo } = await import("../../config/sessions/delivery-info.js");
  const sessions = await import("../../config/sessions.js");
  vi.mocked(sessions.extractDeliveryInfo).mockImplementationOnce(extractDeliveryInfo);
  return { sessionKey, storePath };
}

function readCapturedPayload(): RestartSentinelPayload {
  if (!sentinelState.capturedPayload) {
    throw new Error("expected restart sentinel payload");
  }
  return sentinelState.capturedPayload;
}

describe("update.run acknowledgement", () => {
  const sessionKey = "agent:main:slack:dm:C0123ABC:thread:1234567890.123456";
  const canonicalSessionKey = "agent:main:slack:dm:c0123abc:thread:1234567890.123456";

  it("keeps an operator update out of the selected non-owner chat", async () => {
    managedPackage();
    const response = await captureUpdateRunPayload(
      { sessionKey },
      { commands: { ownerAllowFrom: ["telegram:12345"] } },
    );
    expect(response).toMatchObject({ ok: true, ackDelivered: false, ackQueued: false });
    expect(startHandoff).toHaveBeenCalledOnce();
    expect(sendNotice).not.toHaveBeenCalled();
    expect(getUpdateRun(expectDefined(response, "update response").runId)).toMatchObject({
      origin: { sessionKey: canonicalSessionKey },
      verification: { noticeDelivered: false },
    });
  });
  it.each([
    ["channel disabled", false, undefined, "work", false],
    ["account enabled", false, true, "work", true],
    ["account disabled", true, false, "work", false],
    ["unset", undefined, undefined, "work", true],
    ["default account enabled", false, true, undefined, true],
    ["default account disabled", true, false, undefined, false],
  ] as const)(
    "honors update notice send policy (%s)",
    async (_name, base, account, accountId, allowed) => {
      const sessions = await import("../../config/sessions.js");
      vi.mocked(sessions.extractDeliveryInfo).mockResolvedValueOnce({
        deliveryContext: { channel: "telegram", to: "12345", accountId },
        threadId: undefined,
      });
      resolveNoticeRoute.mockReturnValueOnce({
        channel: "telegram",
        to: "12345",
        accountId,
        threadId: undefined,
      });
      managedPackage();
      const response = await captureUpdateRunPayload(
        { sessionKey: "agent:main:telegram:dm:12345" },
        {
          update: {},
          commands: { ownerAllowFrom: ["telegram:12345"] },
          channels: {
            telegram: {
              actions: { sendMessage: base },
              defaultAccount: "work",
              accounts: { work: { actions: { sendMessage: account } } },
            },
          },
        },
      );
      expect(response).toMatchObject({ ok: true, ackDelivered: allowed, ackQueued: allowed });
      expect(startHandoff).toHaveBeenCalledOnce();
      expect(sendNotice).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (!allowed) {
        expect(getUpdateRun(expectDefined(response, "update response").runId)).toMatchObject({
          verification: { noticeDelivered: false },
        });
      }
    },
  );

  it("rejects an ambiguous session alias before recording or handing off an update", async () => {
    const respond = vi.fn();
    await invokeUpdateRun({ sessionKey: "global" }, respond, {
      agents: { entries: { operations: {}, research: {} } },
    });
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("agent"),
      }),
    );
    expect(listUpdateRuns()).toEqual([]);
    expect(startHandoff).not.toHaveBeenCalled();
    expect(sentinelState.capturedPayload).toBeUndefined();
  });

  it.each([false, true])(
    "awaits the chat acknowledgement before updating (managed=%s)",
    async (managed) => {
      managedPackage();
      const { delivered: acknowledgement, started: acknowledgementStarted } = deferNotice();
      const running = captureUpdateRunPayload({ sessionKey });
      try {
        await Promise.race([acknowledgementStarted.promise, running]);
        expect(sendNotice).toHaveBeenCalledOnce();
        expect(startHandoff).not.toHaveBeenCalled();
      } finally {
        acknowledgement.resolve(true);
        await running;
      }
      const response = await running;
      expect(response?.ackDelivered).toBe(true);
      expect(response?.runId).toEqual(expect.any(String));
      const run = getUpdateRun(response!.runId);
      expect(run).toMatchObject({
        runId: response?.runId,
        status: "running",
        origin: { sessionKey: canonicalSessionKey },
      });
      expect(listUpdateRuns()).toHaveLength(1);
      expect(readCapturedPayload()).toMatchObject({
        stats: { runId: response?.runId },
        sessionKey: canonicalSessionKey,
      });
      if (managed) {
        expect(sendNotice).toHaveBeenCalledOnce();
        expectHandoff({
          runId: response?.runId,
          meta: expect.objectContaining({ runId: response?.runId }),
        });
        const handoffStep = run?.steps.find(
          (step) => step.step === "managed-service update handoff",
        );
        expect(handoffStep).toMatchObject({ status: "completed" });
        expect(handoffStep?.detail).toBeUndefined();
      } else {
        expectHandoff({ runId: response?.runId });
        expect(run?.phase).toBe("requested");
      }
      expect(sendNotice).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: canonicalSessionKey,
          channel: "slack",
          to: "C0123ABC",
          threadId: "1234567890.123456",
          message: "⬆️ Updating OpenClaw… You'll get a message here when it's done.",
          deliveryIntentId: expect.stringMatching(/^update-run-ack:/),
        }),
        expect.any(Object),
      );
    },
  );

  it("awaits one parking notice without advancing the updater phases", async () => {
    managedPackage();
    const response = await captureUpdateRunPayload({ sessionKey });
    const beforePark = startHandoff.mock.calls[0]?.[0].beforePark;
    if (!response || !beforePark) {
      throw new Error("expected admitted managed handoff");
    }
    expect(getUpdateRun(response.runId)?.phase).toBe("requested");
    expect(sendNotice).toHaveBeenCalledOnce();
    const { delivered, started } = deferNotice();
    let parked = false;
    const park = beforePark().then(() => {
      parked = true;
    });
    try {
      await Promise.race([started.promise, park]);
      expect(sendNotice).toHaveBeenCalledTimes(2);
      expect(getUpdateRun(response.runId)?.phase).toBe("requested");
      expect(parked).toBe(false);
    } finally {
      delivered.resolve(true);
    }
    await park;
    await beforePark();
    expect(getUpdateRun(response.runId)?.phase).toBe("requested");
    recordUpdateRunPhase(response.runId, "staging");
    const validating = recordUpdateRunPhase(response.runId, "validating");
    expect(
      validating.steps
        .filter(({ step }) => ["requested", "staging", "validating"].includes(step))
        .map(({ step }) => step),
    ).toEqual(["requested", "staging", "validating"]);
    expect(sendNotice).toHaveBeenCalledTimes(2);
    expect(sendNotice).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: restarting }),
      expect.any(Object),
    );
  });

  it.each([
    [GATEWAY_CLIENT_IDS.CONTROL_UI, GATEWAY_CLIENT_MODES.WEBCHAT, true],
    [GATEWAY_CLIENT_IDS.MACOS_APP, GATEWAY_CLIENT_MODES.UI, true],
    [GATEWAY_CLIENT_IDS.IOS_APP, GATEWAY_CLIENT_MODES.UI, false],
  ] as const)(
    "keeps the update receipt out of the chat only for desktop and browser (%s)",
    async (id, mode, inApp) => {
      managedPackage();
      const sessionId = "app-update-notice";
      const { sessionKey: internalSessionKey, storePath } = await internalSession(sessionId);
      const respond = vi.fn();
      await invokeUpdateRun(
        { sessionKey: internalSessionKey, requester: { channel: INTERNAL_MESSAGE_CHANNEL } },
        respond,
        undefined,
        {},
        {
          client: { connect: { client: { id, mode } } } as NonNullable<
            Parameters<typeof invokeUpdateRun>[4]
          >["client"],
        },
      );
      const run = expectDefined(listUpdateRuns()[0], "update run receipt");
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId: run.runId }),
        undefined,
      );
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionId,
        sessionKey,
        storePath,
      });
      const messages = events.filter(
        (event) =>
          event !== null &&
          typeof event === "object" &&
          "type" in event &&
          event.type === "message",
      );
      if (inApp) {
        expect(messages).toEqual([]);
        expect(run.origin.noticeSurface).toBe("app");
      } else {
        expect(messages).toContainEqual(
          expect.objectContaining({
            message: expect.objectContaining({
              idempotencyKey: `update-run-ack:${run.runId}`,
            }),
          }),
        );
        expect(run.origin.noticeSurface).toBeUndefined();
      }
    },
  );

  it("persists the internal activating notice through the transferred helper before parking", async () => {
    const sessionId = "internal-managed-update";
    const { sessionKey: internalSessionKey, storePath } = await internalSession(sessionId);
    mockGlobalInstallSurface();
    detectSupervisor.mockReturnValue("launchd");
    let noticeCommitted = false;
    await withTransferredUpdateHandoff(
      path.dirname(storePath),
      async (runId) => {
        const messages = await loadTranscriptEvents({
          agentId: "main",
          sessionId,
          sessionKey: internalSessionKey,
          storePath,
        });
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              idempotencyKey: `update-run-activating:${runId}`,
              content: [{ type: "text", text: restarting }],
            }),
          }),
        );
        expect(getUpdateRun(runId)?.steps).toContainEqual(
          expect.objectContaining({ step: "notice:activating", status: "completed" }),
        );
        noticeCommitted = true;
      },
      async (activate) => {
        const response = await captureUpdateRunPayload({ sessionKey: internalSessionKey });
        expect(response).toMatchObject({ ok: true, ackDelivered: true });
        expect(noticeCommitted).toBe(false);
        recordUpdateRunPhase(response!.runId, "activating", { after: { version: "2.0.0" } });
        await activate();
        await vi.waitFor(() => expect(noticeCommitted).toBe(true), { timeout: 5_000 });
      },
    );
  });

  it("continues the update when the bounded acknowledgement fails", async () => {
    managedPackage();
    sendNotice.mockResolvedValueOnce(false);
    const response = await captureUpdateRunPayload({ sessionKey });
    expect(response?.ackDelivered).toBe(false);
    expect(startHandoff).toHaveBeenCalledOnce();
  });

  it("records an internal API origin from only its persisted session key", async () => {
    managedPackage();
    const { sessionKey: internalSessionKey } = await internalSession("internal-api-update");
    const response = await captureUpdateRunPayload({ sessionKey: internalSessionKey });
    expect(response).toMatchObject({ ok: true, ackDelivered: true });
    const run = getUpdateRun(response!.runId);
    expect(run).toMatchObject({ trigger: "api", origin: { sessionKey: internalSessionKey } });
    expect(run?.origin.deliveryContext).toEqual({ channel: INTERNAL_MESSAGE_CHANNEL });
  });

  it("does not acknowledge a preflight refusal or a missing route", async () => {
    isRestartEnabledMock.mockReturnValue(false);
    expect((await captureUpdateRunPayload({ sessionKey }))?.ackDelivered).toBe(false);
    isRestartEnabledMock.mockReturnValue(true);
    expect((await captureUpdateRunPayload({}))?.ackDelivered).toBe(false);
    expect(sendNotice).not.toHaveBeenCalled();
  });
});

it("update.run preserves the sentinel webchat route", async () => {
  managedPackage();
  const sessionKey = "agent:main:webchat:dm:user-123";
  expect((await captureUpdateRunPayload({ sessionKey }))?.ok).toBe(true);
  expect(adoptUpdateCampaignMock).toHaveBeenCalledOnce();
  const payload = readCapturedPayload();
  expect(payload.deliveryContext).toEqual({
    channel: "webchat",
    to: "webchat:user-123",
    accountId: "default",
  });
  expect(payload.threadId).toBeUndefined();
  expect(payload.continuation).toBeUndefined();
});
describe("update.run restart scheduling", () => {
  it.each([
    { supervisor: "launchd", restartDelayMs: 0, expectedDelayMs: 0 },
    { supervisor: "systemd", restartDelayMs: 500, expectedDelayMs: 500 },
    { supervisor: "systemd", restartDelayMs: 2_147_153_648, expectedDelayMs: 60_000 },
  ] as const)(
    "keeps $supervisor serving until activation despite restartDelayMs=$restartDelayMs",
    async ({ supervisor, restartDelayMs, expectedDelayMs }) => {
      detectSupervisor.mockReturnValueOnce(supervisor);
      mockGlobalInstallSurface();
      const payload = await captureUpdateRunPayload({ restartDelayMs });
      expectServingHandoff(payload, {
        supervisor,
        restartDrainTimeoutMs: 300_000,
        restartDelayMs: expectedDelayMs,
      });
    },
  );

  it("starts managed package handoff when the gateway cwd is unavailable", async () => {
    detectSupervisor.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("uv_cwd"), { code: "ENOENT", syscall: "uv_cwd" });
    });
    try {
      await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
        invokeUpdateRun({}),
      );
    } finally {
      cwdSpy.mockRestore();
    }

    expect(startHandoff).toHaveBeenCalledOnce();
    expectHandoff({ root: "/tmp/openclaw-global" });
  });

  it("forwards stored extended-stable to package managed-service handoff", async () => {
    normalizeUpdateChannelMock.mockReturnValueOnce("extended-stable");
    detectSupervisor.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );

    expectHandoff({ channel: "extended-stable" });
  });

  it("accepts a foreground global install without inventing a native service identity", async () => {
    mockGlobalInstallSurface();
    const payload = await captureUpdateRunPayload({ timeoutMs: 1_800_000 });
    expect(scheduleRestart).not.toHaveBeenCalled();
    expectHandoff({
      foregroundOrigin: expect.objectContaining({ pid: process.pid }),
      root: "/tmp/openclaw-global",
    });
    expect(payload).toMatchObject({
      ok: true,
      handoff: { status: "started", command: "openclaw update --yes --timeout 1800" },
      result: { status: "skipped", reason: "managed-service-handoff-started" },
    });
    expect(startHandoff.mock.calls[0]?.[0].meta.completionOwner).toBe("gateway-restart");
    expect(startHandoff).toHaveBeenCalledOnce();
    expect(getUpdateRun(payload!.runId)?.status).toBe("running");
  });

  it("blocks global package installs when the gateway cannot restart afterward", async () => {
    isRestartEnabledMock.mockReturnValue(false);
    detectSupervisor.mockReturnValue(null);
    mockGlobalInstallSurface();

    const payload = await captureUpdateRunPayload();
    expect(scheduleRestart).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      ok: false,
      result: { status: "skipped", reason: "restart-unavailable", mode: "npm" },
    });
  });

  it("keeps external update supervision authoritative even with native systemd markers", async () => {
    mockGlobalInstallSurface();
    detectSupervisor.mockReturnValue("systemd");

    const payload = await withEnvAsync(
      {
        OPENCLAW_SUPERVISOR_MODE: "external",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
      },
      () => captureUpdateRunPayload(),
    );
    expect(startHandoff).not.toHaveBeenCalled();
    expect(scheduleRestart).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      ok: false,
      restart: null,
      result: { status: "skipped", mode: "npm", reason: "external-supervisor-update-required" },
    });
  });
});

describe("update.run prepared foreground handoff", () => {
  it("does not hand off an unverified foreground process", async () => {
    readGatewayOwnerLeaseAsyncMock.mockResolvedValueOnce(undefined);
    const payload = await captureUpdateRunPayload();
    expect(payload?.ok).toBe(false);
    expect(startHandoff).not.toHaveBeenCalled();
    expect(scheduleRestart).not.toHaveBeenCalled();
  });
});
