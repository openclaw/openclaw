// Update method tests cover update.run/status, restart sentinel metadata,
// managed-service handoff, restart scheduling, and delivery context preservation.

import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
  recordLatestUpdateRestartSentinelMock,
  isRestartEnabledMock,
  detectRespawnSupervisorMock,
  normalizeUpdateChannelMock,
  getUpdateAvailableMock,
  adoptUpdateCampaignMock,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
  cancelManagedServiceUpdateHandoffMock,
  claimManagedServiceUpdateHandoffMock,
  sendGatewayLifecycleNoticeMock,
  resolveGatewayLifecycleNoticeRouteMock,
  scheduleGatewayRestartMock,
  readGatewayOwnerLeaseMock,
  invokeUpdateRun,
  captureUpdateRunPayload,
  mockGlobalInstallSurface,
  mockGitInstallSurface,
} from "./update.test-harness.js";

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
    const response = await captureUpdateRunPayload(
      { sessionKey },
      { commands: { ownerAllowFrom: ["telegram:12345"] } },
    );
    expect(response).toMatchObject({ ok: true, ackDelivered: false, ackQueued: false });
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    expect(sendGatewayLifecycleNoticeMock).not.toHaveBeenCalled();
    expect(getUpdateRun(expectDefined(response, "update response").runId)).toMatchObject({
      origin: { sessionKey: canonicalSessionKey },
      verification: { noticeDelivered: false },
    });
  });
  it.each([
    {
      name: "channel disabled",
      base: false,
      account: undefined,
      accountId: "work",
      allowed: false,
    },
    { name: "account enabled", base: false, account: true, accountId: "work", allowed: true },
    { name: "account disabled", base: true, account: false, accountId: "work", allowed: false },
    { name: "unset", base: undefined, account: undefined, accountId: "work", allowed: true },
    {
      name: "default account enabled",
      base: false,
      account: true,
      accountId: undefined,
      allowed: true,
    },
    {
      name: "default account disabled",
      base: true,
      account: false,
      accountId: undefined,
      allowed: false,
    },
  ])("honors update notice send policy ($name)", async ({ base, account, accountId, allowed }) => {
    const sessions = await import("../../config/sessions.js");
    vi.mocked(sessions.extractDeliveryInfo).mockReturnValueOnce({
      deliveryContext: { channel: "telegram", to: "12345", accountId },
      threadId: undefined,
    });
    resolveGatewayLifecycleNoticeRouteMock.mockReturnValueOnce({
      channel: "telegram",
      to: "12345",
      accountId,
      threadId: undefined,
    });
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
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (!allowed) {
      expect(getUpdateRun(expectDefined(response, "update response").runId)).toMatchObject({
        verification: { noticeDelivered: false },
      });
    }
  });

  it("rejects an ambiguous session alias before recording or handing off an update", async () => {
    const respond = vi.fn();
    await invokeUpdateRun({ sessionKey: "global" }, respond, {
      agents: { list: [{ id: "operations" }, { id: "research" }] },
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
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(sentinelState.capturedPayload).toBeUndefined();
  });

  it.each([false, true])(
    "awaits the chat acknowledgement before updating (managed=%s)",
    async (managed) => {
      if (managed) {
        mockGlobalInstallSurface();
        detectRespawnSupervisorMock.mockReturnValue("launchd");
        getUpdateAvailableMock.mockReturnValue({
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
          channel: "stable",
        });
      }
      const acknowledgement = createDeferredCore<boolean>();
      const acknowledgementStarted = createDeferredCore();
      sendGatewayLifecycleNoticeMock.mockImplementationOnce(() => {
        acknowledgementStarted.resolve();
        return acknowledgement.promise;
      });
      const running = captureUpdateRunPayload({ sessionKey });
      try {
        await Promise.race([acknowledgementStarted.promise, running]);
        expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledOnce();
        expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
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
      expect(readCapturedPayload().stats?.runId).toBe(response?.runId);
      expect(readCapturedPayload().sessionKey).toBe(canonicalSessionKey);
      if (managed) {
        expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledOnce();
        expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: response?.runId,
            meta: expect.objectContaining({ runId: response?.runId }),
          }),
        );
        expect(run?.steps).toContainEqual(
          expect.objectContaining({ step: "managed-service update handoff", status: "completed" }),
        );
        expect(
          run?.steps.find((step) => step.step === "managed-service update handoff")?.detail,
        ).toBeUndefined();
      } else {
        expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
          expect.objectContaining({ runId: response?.runId }),
        );
        expect(run?.phase).toBe("requested");
      }
      expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: canonicalSessionKey,
          channel: "slack",
          to: "C0123ABC",
          threadId: "1234567890.123456",
          message: `⬆️ Updating OpenClaw 1.0.0 → ${managed ? "2.0.0" : "the latest release"}. The gateway stays available while the update is validated; you'll get a message here when it finishes.`,
          deliveryIntentId: expect.stringMatching(/^update-run-ack:/),
        }),
        expect.any(Object),
      );
    },
  );

  it("merges explicit route fields and refuses a second prepared updater after acknowledgement", async () => {
    startManagedServiceUpdateHandoffMock.mockResolvedValueOnce({
      status: "joined",
      command: "openclaw update --yes",
      logPath: "/tmp/fixture.log",
    });
    const response = await captureUpdateRunPayload({
      sessionKey,
      deliveryContext: { to: "slack:C0456DEF" },
    });
    expect(response).toMatchObject({
      ackDelivered: true,
      ok: false,
      result: { reason: "managed-service-handoff-already-running" },
    });
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(sendGatewayLifecycleNoticeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: "C0456DEF" }),
      expect.any(Object),
    );
    expect(sentinelState.capturedPayload).toBeUndefined();
  });

  it("awaits one parking notice without advancing the updater phases", async () => {
    mockGlobalInstallSurface();
    detectRespawnSupervisorMock.mockReturnValue("launchd");
    getUpdateAvailableMock.mockReturnValue({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    });
    const response = await captureUpdateRunPayload({ sessionKey });
    const beforePark = startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0].beforePark;
    if (!response || !beforePark) {
      throw new Error("expected admitted managed handoff");
    }
    expect(getUpdateRun(response.runId)?.phase).toBe("requested");
    expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledOnce();
    const delivered = createDeferredCore<boolean>();
    const started = createDeferredCore();
    sendGatewayLifecycleNoticeMock.mockImplementationOnce(() => {
      started.resolve();
      return delivered.promise;
    });
    let parked = false;
    const park = beforePark().then(() => {
      parked = true;
    });
    try {
      await Promise.race([started.promise, park]);
      expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledTimes(2);
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
    expect(sendGatewayLifecycleNoticeMock).toHaveBeenCalledTimes(2);
    expect(sendGatewayLifecycleNoticeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "⏳ Restarting the gateway now (v1.0.0 → v2.0.0)…",
      }),
      expect.any(Object),
    );
  });

  it("continues the update when the bounded acknowledgement fails", async () => {
    sendGatewayLifecycleNoticeMock.mockResolvedValueOnce(false);
    const response = await captureUpdateRunPayload({ sessionKey });
    expect(response?.ackDelivered).toBe(false);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
  });

  it("persists the internal activating notice through the transferred helper before parking", async () => {
    const internalSessionKey = "agent:main:webchat:lane";
    const storePath = resolveDefaultSessionStorePath("main");
    const sessionId = "internal-managed-update";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: internalSessionKey, storePath },
      { sessionId, updatedAt: 1, delivery: { kind: "internal" } },
    );
    const { extractDeliveryInfo } = await import("../../config/sessions/delivery-info.js");
    const sessions = await import("../../config/sessions.js");
    vi.mocked(sessions.extractDeliveryInfo).mockImplementationOnce(extractDeliveryInfo);
    mockGlobalInstallSurface();
    detectRespawnSupervisorMock.mockReturnValue("launchd");
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
              content: [{ type: "text", text: "⏳ Restarting the gateway now (v1.0.0 → v2.0.0)…" }],
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

  it("records an internal API origin from only its persisted session key", async () => {
    const internalSessionKey = "agent:main:webchat:lane";
    await upsertSessionEntryCore(
      {
        agentId: "main",
        sessionKey: internalSessionKey,
        storePath: resolveDefaultSessionStorePath("main"),
      },
      { sessionId: "internal-api-update", updatedAt: 1, delivery: { kind: "internal" } },
    );
    const { extractDeliveryInfo } = await import("../../config/sessions/delivery-info.js");
    const sessions = await import("../../config/sessions.js");
    vi.mocked(sessions.extractDeliveryInfo).mockImplementationOnce(extractDeliveryInfo);
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
    expect(sendGatewayLifecycleNoticeMock).not.toHaveBeenCalled();
  });
});

describe("update.run sentinel deliveryContext", () => {
  it.each([
    { sessionKey: undefined, deliveryContext: undefined, threadId: undefined },
    {
      sessionKey: "agent:main:webchat:dm:user-123",
      deliveryContext: { channel: "webchat", to: "webchat:user-123", accountId: "default" },
      threadId: undefined,
    },
    {
      sessionKey: "agent:main:slack:dm:C0123ABC:thread:1234567890.123456",
      deliveryContext: { channel: "slack", to: "slack:C0123ABC", accountId: "workspace-1" },
      threadId: "1234567890.123456",
    },
  ])(
    "preserves the sentinel route for $sessionKey",
    async ({ sessionKey, deliveryContext, threadId }) => {
      expect((await captureUpdateRunPayload({ sessionKey }))?.ok).toBe(true);
      expect(adoptUpdateCampaignMock).toHaveBeenCalledOnce();
      const payload = readCapturedPayload();
      expect(payload.deliveryContext).toEqual(deliveryContext);
      expect(payload.threadId).toBe(threadId);
      expect(payload.continuation).toBeUndefined();
    },
  );

  it("carries continuationMessage to the updater without running it on acceptance", async () => {
    await invokeUpdateRun({
      sessionKey: "agent:main:webchat:dm:user-123",
      continuationMessage: "Check the running version and finish the update report.",
    });

    expect(readCapturedPayload().continuation).toBeUndefined();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          continuationMessage: "Check the running version and finish the update report.",
        }),
      }),
    );
  });
});

describe("update.run timeout normalization", () => {
  it("enforces a 1000ms minimum timeout for tiny values", async () => {
    await invokeUpdateRun({ timeoutMs: 1 });

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ timeoutMs: 1000 }),
    );
  });
});

describe("update.run restart scheduling", () => {
  it("schedules the foreground continuation when update is accepted", async () => {
    const payload = await captureUpdateRunPayload();

    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(true);
    expect(payload?.restart).toBeNull();
    await startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0].beforePark?.();
    expect(scheduleGatewayRestartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        successorOwner: expect.objectContaining({ handoffId: expect.any(String) }),
      }),
    );
  });

  it("persists managed update continuation before transferring validation while serving", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();

    const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload({}, {}),
    );
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/openclaw-global",
        restartDrainTimeoutMs: 300_000,
        restartDelayMs: 0,
        handoffId: expect.any(String),
        supervisor: "launchd",
        meta: expect.objectContaining({
          handoffId: expect.any(String),
          root: "/tmp/openclaw-global",
        }),
      }),
    );
    const handoffId = startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0].handoffId;
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ handoffId }),
      }),
    );
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledExactlyOnceWith({
      kind: "managed-update-handoff",
      handoffId,
      installRoot: "/tmp/openclaw-global",
    });
    expect(recordLatestUpdateRestartSentinelMock.mock.invocationCallOrder[0]).toBeLessThan(
      transferManagedServiceUpdateHandoffMock.mock.invocationCallOrder[0]!,
    );
    expect(cancelManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(payload?.restart).toBeNull();
    expect(payload?.ok).toBe(true);
    expect(payload?.result?.status).toBe("skipped");
    expect(payload?.result?.reason).toBe("managed-service-handoff-started");
    expect(payload?.handoff).toEqual({
      status: "started",
      pid: 12345,
      command: "openclaw update --yes --timeout 1800",
    });
    expect(payload?.sentinel?.persisted).toBe(true);
    const sentinel = readCapturedPayload();
    expect(sentinel.kind).toBe("update");
    expect(sentinel.status).toBe("skipped");
    expect(sentinel.stats).toEqual(
      expect.objectContaining({
        handoffId,
        reason: "managed-service-handoff-started",
      }),
    );
    expect(recordLatestUpdateRestartSentinelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "update",
        status: "skipped",
        stats: expect.objectContaining({
          reason: "managed-service-handoff-started",
        }),
      }),
    );
  });

  it("rejects a joining request instead of dropping its restart continuation", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();
    startManagedServiceUpdateHandoffMock.mockResolvedValueOnce({
      status: "joined",
      pid: 12345,
      command: "openclaw update --yes --timeout 1800",
      logPath: "/tmp/openclaw-update-run-handoff/handoff.log",
      handoffId: "handoff-existing",
    });

    const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload({
        sessionKey: "agent:main:webchat:dm:user-123",
        continuationMessage: "Report the update result after restart.",
      }),
    );

    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(recordLatestUpdateRestartSentinelMock).not.toHaveBeenCalled();
    expect(sentinelState.capturedPayload).toBeUndefined();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          sessionKey: "agent:main:webchat:dm:user-123",
          continuationMessage: "Report the update result after restart.",
        }),
      }),
    );
    expect(payload?.ok).toBe(false);
    expect(payload?.result).toMatchObject({
      status: "skipped",
      reason: "managed-service-handoff-already-running",
    });
    expect(payload?.handoff).toEqual({
      status: "already-running",
      command: "openclaw update --yes --timeout 1800",
      message: "Another managed update is already running; retry after it completes.",
    });
    expect(payload?.sentinel?.persisted).toBe(false);
  });

  it("cancels foreground parking when its accepted notice cannot be persisted", async () => {
    sentinelState.restartSentinelWriteError = new Error("state database unavailable");
    const payload = await captureUpdateRunPayload();
    expect(cancelManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({ ok: false, sentinel: { persisted: false } });
    const run = getUpdateRun(payload!.runId);
    expect(run).toMatchObject({
      status: "failed",
      reason: "managed-service-handoff-failed",
    });
    expect(run?.steps).toContainEqual(
      expect.objectContaining({
        step: "requested",
        status: "failed",
        failureFacts: [
          expect.objectContaining({
            check: "managed-service",
            code: "Error",
            errorName: "Error",
            message: "state database unavailable",
          }),
        ],
      }),
    );
  });

  it.each([
    { supervisor: "launchd", restartDelayMs: 0, expectedDelayMs: 0 },
    { supervisor: "systemd", restartDelayMs: 0, expectedDelayMs: 0 },
    { supervisor: "systemd", restartDelayMs: 500, expectedDelayMs: 500 },
    { supervisor: "launchd", restartDelayMs: 2_147_153_648, expectedDelayMs: 60_000 },
    { supervisor: "systemd", restartDelayMs: 2_147_153_648, expectedDelayMs: 60_000 },
  ] as const)(
    "keeps $supervisor serving until activation despite restartDelayMs=$restartDelayMs",
    async ({ supervisor, restartDelayMs, expectedDelayMs }) => {
      detectRespawnSupervisorMock.mockReturnValueOnce(supervisor);
      mockGlobalInstallSurface();

      const payload = await captureUpdateRunPayload({ restartDelayMs });

      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
        expect.objectContaining({
          supervisor,
          restartDrainTimeoutMs: 300_000,
          restartDelayMs: expectedDelayMs,
        }),
      );
      expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
      expect(payload).toMatchObject({ ok: true, restart: null });
    },
  );

  it("starts managed package handoff when the gateway cwd is unavailable", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
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

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/openclaw-global",
      }),
    );
  });

  it("delegates Git preflight to the same prepared updater while serving", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGitInstallSurface("/tmp/openclaw-git");
    const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/openclaw-git",
        handoffId: expect.any(String),
        supervisor: "launchd",
        meta: expect.objectContaining({
          handoffId: expect.any(String),
          root: "/tmp/openclaw-git",
        }),
      }),
    );
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    expect(payload?.ok).toBe(true);
    expect(payload?.result?.status).toBe("skipped");
    expect(payload?.result?.reason).toBe("managed-service-handoff-started");
    expect(payload?.result?.mode).toBe("git");
    expect(payload?.handoff).toEqual({
      status: "started",
      pid: 12345,
      command: "openclaw update --yes --timeout 1800",
    });
    expect(readCapturedPayload().status).toBe("skipped");
  });

  it("keeps the serving Gateway when its prepared helper cannot start", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(
      new Error("fixture helper import failed"),
    );
    const payload = await captureUpdateRunPayload();
    expect(payload).toMatchObject({
      ok: false,
      result: { status: "error", reason: "managed-service-handoff-failed" },
    });
    expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
  });

  it("hands Windows fallback gateways to the CLI path before doctor activation", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("schtasks");
    mockGitInstallSurface("C:\\openclaw");

    const payload = await withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
      () => captureUpdateRunPayload(),
    );

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        supervisor: "schtasks",
        handoffId: expect.any(String),
      }),
    );
    expect(payload?.ok).toBe(true);
    expect(payload?.result?.reason).toBe("managed-service-handoff-started");
  });

  it("does not pass the stored stable channel to supervised git handoff CLI", async () => {
    normalizeUpdateChannelMock.mockReturnValueOnce("stable");
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGitInstallSurface("/tmp/openclaw-git");

    const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0]).not.toHaveProperty("channel");
    expect(payload?.handoff?.command).not.toContain("--channel");
  });

  it("defers saved Git channel validation to the canonical updater without an installation switch", async () => {
    normalizeUpdateChannelMock.mockReturnValueOnce("extended-stable");
    mockGitInstallSurface("/tmp/openclaw-git");
    const payload = await captureUpdateRunPayload();
    expect(payload?.ok).toBe(true);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ channel: expect.anything() }),
    );
  });

  it("forwards stored extended-stable to package managed-service handoff", async () => {
    normalizeUpdateChannelMock.mockReturnValueOnce("extended-stable");
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "extended-stable" }),
    );
  });

  it.each(["git", "global"])(
    "accepts foreground %s updates through the restart lifecycle",
    async (kind) => {
      if (kind === "git") {
        mockGitInstallSurface("/tmp/openclaw-git");
      } else {
        mockGlobalInstallSurface();
      }
      const payload = await captureUpdateRunPayload();
      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      expect(payload).toMatchObject({
        ok: true,
        handoff: { status: "started" },
        result: { status: "skipped", reason: "managed-service-handoff-started" },
      });
      expect(startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0].meta.completionOwner).toBe(
        "gateway-restart",
      );
      expect(getUpdateRun(payload!.runId)?.status).toBe("running");
    },
  );

  it("hands systemd-supervised git/dev updates to handoff from the durable unit identity", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("systemd");
    mockGitInstallSurface("/tmp/openclaw-git");

    const payload = await withEnvAsync(
      {
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
        INVOCATION_ID: "8a77e69a8f604bf0b7984879b9f17a7c",
      },
      () => captureUpdateRunPayload(),
    );

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(1);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/openclaw-git",
        supervisor: "systemd",
      }),
    );
    expect(payload?.ok).toBe(true);
    expect(payload?.result?.status).toBe("skipped");
    expect(payload?.result?.reason).toBe("managed-service-handoff-started");
    expect(payload?.result?.mode).toBe("git");
    expect(payload?.handoff?.status).toBe("started");
  });

  it("hands marker-only systemd git/dev updates to the helper for exact ownership verification", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("systemd");
    mockGitInstallSurface("/tmp/openclaw-git");

    const payload = await withEnvAsync(
      {
        OPENCLAW_SYSTEMD_UNIT: undefined,
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
      () => captureUpdateRunPayload(),
    );
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({ root: "/tmp/openclaw-git", supervisor: "systemd" }),
    );
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    expect(payload?.ok).toBe(true);
    expect(payload?.result?.status).toBe("skipped");
    expect(payload?.result?.reason).toBe("managed-service-handoff-started");
    expect(payload?.result?.mode).toBe("git");
    expect(payload?.handoff?.status).toBe("started");
  });

  it("accepts a foreground global install without inventing a native service identity", async () => {
    mockGlobalInstallSurface();
    const payload = await captureUpdateRunPayload({ timeoutMs: 1_800_000 });
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        foregroundOrigin: expect.objectContaining({ pid: process.pid }),
        root: "/tmp/openclaw-global",
      }),
    );
    expect(payload).toMatchObject({
      ok: true,
      handoff: { status: "started", command: "openclaw update --yes --timeout 1800" },
    });
    expect(startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0].meta.completionOwner).toBe(
      "gateway-restart",
    );
  });

  it("blocks global package installs when the gateway cannot restart afterward", async () => {
    isRestartEnabledMock.mockReturnValue(false);
    detectRespawnSupervisorMock.mockReturnValue(null);
    mockGlobalInstallSurface();

    const payload = await captureUpdateRunPayload();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(false);
    expect(payload?.result?.status).toBe("skipped");
    expect(payload?.result?.reason).toBe("restart-unavailable");
    expect(payload?.result?.mode).toBe("npm");
  });

  it("keeps external update supervision authoritative even with native systemd markers", async () => {
    mockGlobalInstallSurface();
    detectRespawnSupervisorMock.mockReturnValue("systemd");

    const payload = await withEnvAsync(
      {
        OPENCLAW_SUPERVISOR_MODE: "external",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
      },
      () => captureUpdateRunPayload(),
    );
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(false);
    expect(payload?.restart).toBeNull();
    expect(payload?.result).toMatchObject({
      status: "skipped",
      mode: "npm",
      reason: "external-supervisor-update-required",
    });
  });
});

describe("update.run prepared foreground handoff", () => {
  it("keeps serving until the prepared updater requests parking, using the same transferred owner", async () => {
    const payload = await captureUpdateRunPayload({ restartDelayMs: 7_000 });
    expect(payload).toMatchObject({
      ok: true,
      sentinel: { persisted: true },
      handoff: { status: "started" },
    });
    const params = expectDefined(
      startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0],
      "handoff parameters",
    );
    expect(params).toMatchObject({
      supervisor: null,
      restartDelayMs: 7_000,
      foregroundOrigin: { owner: "foreground-owner", pid: process.pid },
      meta: { completionOwner: "gateway-restart", runId: payload!.runId },
    });
    expect(params.foregroundOrigin?.stateDatabasePath).toEqual(expect.any(String));
    expect(params.foregroundOrigin?.configPath).toEqual(expect.any(String));
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    await params.beforePark?.();
    expect(scheduleGatewayRestartMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        delayMs: 0,
        reason: "update.run",
        successorOwner: transferManagedServiceUpdateHandoffMock.mock.calls[0]?.[0],
      }),
    );
    expect(getUpdateRun(payload!.runId)?.status).toBe("running");
  });

  it("rechecks revocable chat authority after the awaited parking notice", async () => {
    const config: OpenClawConfig = { commands: { ownerAllowFrom: ["slack:C0123ABC"] } };
    await captureUpdateRunPayload(
      {
        sessionKey: "agent:main:slack:dm:C0123ABC:thread:1234567890.123456",
        requester: { channel: "slack", senderId: "C0123ABC" },
      },
      config,
    );
    const params = expectDefined(
      startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0],
      "handoff parameters",
    );
    sendGatewayLifecycleNoticeMock.mockImplementationOnce(async () => {
      config.commands = { ownerAllowFrom: ["slack:OTHER"] };
      return true;
    });
    await expect(params.beforePark?.()).rejects.toThrow("authority changed");
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
  });

  it("keeps serving when its foreground helper loses its claim during the parking notice", async () => {
    await captureUpdateRunPayload({
      sessionKey: "agent:main:slack:dm:C0123ABC:thread:1234567890.123456",
      requester: { channel: "slack", senderId: "C0123ABC" },
    });
    const handoff = expectDefined(
      startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0],
      "handoff parameters",
    );
    const notice = createDeferredCore<boolean>();
    const noticeStarted = createDeferredCore();
    sendGatewayLifecycleNoticeMock.mockImplementationOnce(() => {
      noticeStarted.resolve();
      return notice.promise;
    });
    const parking = handoff.beforePark?.();
    await noticeStarted.promise;
    claimManagedServiceUpdateHandoffMock.mockReturnValue(false);
    notice.resolve(true);
    await expect(parking).rejects.toThrow("authority changed");
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
  });

  it("does not hand off an unverified foreground process", async () => {
    readGatewayOwnerLeaseMock.mockReturnValueOnce(undefined);
    const payload = await captureUpdateRunPayload();
    expect(payload?.ok).toBe(false);
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
  });
});
