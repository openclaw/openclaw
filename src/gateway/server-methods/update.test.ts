import fs from "node:fs/promises";
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
  recordLatestUpdateRestartSentinelMock as recordSentinel,
  isRestartEnabledMock,
  detectRespawnSupervisorMock as detectSupervisor,
  normalizeUpdateChannelMock,
  getUpdateAvailableMock,
  adoptUpdateCampaignMock,
  startManagedServiceUpdateHandoffMock as startHandoff,
  transferManagedServiceUpdateHandoffMock as transferHandoff,
  cancelManagedServiceUpdateHandoffMock as cancelHandoff,
  claimManagedServiceUpdateHandoffMock as claimHandoff,
  sendGatewayLifecycleNoticeMock as sendNotice,
  resolveGatewayLifecycleNoticeRouteMock as resolveNoticeRoute,
  scheduleGatewayRestartMock as scheduleRestart,
  readGatewayOwnerLeaseMock,
  invokeUpdateRun,
  captureUpdateRunPayload,
  mockGlobalInstallSurface,
  mockGitInstallSurface,
} from "./update.test-harness.js";

function expectHandoff(fields: Record<string, unknown>) {
  expect(startHandoff).toHaveBeenCalledWith(expect.objectContaining(fields));
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

function preparedHandoff() {
  return expectDefined(startHandoff.mock.calls[0]?.[0], "handoff parameters");
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
      if (managed) {
        managedPackage();
      }
      const acknowledgement = createDeferredCore<boolean>();
      const acknowledgementStarted = createDeferredCore();
      sendNotice.mockImplementationOnce(() => {
        acknowledgementStarted.resolve();
        return acknowledgement.promise;
      });
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
      expect(readCapturedPayload().stats?.runId).toBe(response?.runId);
      expect(readCapturedPayload().sessionKey).toBe(canonicalSessionKey);
      if (managed) {
        expect(sendNotice).toHaveBeenCalledOnce();
        expectHandoff({
          runId: response?.runId,
          meta: expect.objectContaining({ runId: response?.runId }),
        });
        expect(run?.steps).toContainEqual(
          expect.objectContaining({ step: "managed-service update handoff", status: "completed" }),
        );
        expect(
          run?.steps.find((step) => step.step === "managed-service update handoff")?.detail,
        ).toBeUndefined();
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

  it("merges explicit route fields and refuses a second prepared updater after acknowledgement", async () => {
    startHandoff.mockResolvedValueOnce({
      status: "joined",
      message:
        "Update blocked by cancelled update custody: owner previous-update; run openclaw update repair.",
      command: "openclaw update --yes",
      logPath: "/tmp/fixture.log",
    });
    const response = await captureUpdateRunPayload({
      sessionKey,
      deliveryContext: { to: "slack:C0456DEF" },
      continuationMessage: "Report the update result after restart.",
    });
    expect(response).toMatchObject({
      ackDelivered: true,
      ok: false,
      result: { reason: "managed-service-handoff-already-running" },
      handoff: {
        message: expect.stringContaining("cancelled update custody: owner previous-update"),
      },
    });
    expect(getUpdateRun(response!.runId)?.origin.nextAction).toContain(
      "cancelled update custody: owner previous-update",
    );
    expect(scheduleRestart).not.toHaveBeenCalled();
    expect(transferHandoff).not.toHaveBeenCalled();
    expect(recordSentinel).not.toHaveBeenCalled();
    expectHandoff({
      meta: expect.objectContaining({
        continuationMessage: "Report the update result after restart.",
      }),
    });
    expect(sendNotice).toHaveBeenLastCalledWith(
      expect.objectContaining({ to: "C0456DEF" }),
      expect.any(Object),
    );
    expect(sentinelState.capturedPayload).toBeUndefined();
  });

  it("awaits one parking notice without advancing the updater phases", async () => {
    managedPackage();
    const response = await captureUpdateRunPayload({ sessionKey });
    const beforePark = startHandoff.mock.calls[0]?.[0].beforePark;
    if (!response || !beforePark) {
      throw new Error("expected admitted managed handoff");
    }
    expect(getUpdateRun(response.runId)?.phase).toBe("requested");
    expect(sendNotice).toHaveBeenCalledOnce();
    const delivered = createDeferredCore<boolean>();
    const started = createDeferredCore();
    sendNotice.mockImplementationOnce(() => {
      started.resolve();
      return delivered.promise;
    });
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
      expect.objectContaining({
        message: "⏳ Restarting OpenClaw…",
      }),
      expect.any(Object),
    );
  });

  it("continues the update when the bounded acknowledgement fails", async () => {
    sendNotice.mockResolvedValueOnce(false);
    const response = await captureUpdateRunPayload({ sessionKey });
    expect(response?.ackDelivered).toBe(false);
    expect(startHandoff).toHaveBeenCalledOnce();
  });

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
              content: [{ type: "text", text: "⏳ Restarting OpenClaw…" }],
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
  it("cancels foreground parking when its accepted notice cannot be persisted", async () => {
    sentinelState.restartSentinelWriteError = new Error("state database unavailable");
    const payload = await captureUpdateRunPayload();
    expect(cancelHandoff).toHaveBeenCalledOnce();
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
          expect.objectContaining({ code: "handoff-payload-failed" }),
        ],
      }),
    );
  });

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

      expectHandoff({
        supervisor,
        restartDrainTimeoutMs: 300_000,
        restartDelayMs: expectedDelayMs,
      });
      expect(transferHandoff).toHaveBeenCalledOnce();
      expect(scheduleRestart).not.toHaveBeenCalled();
      expect(payload).toMatchObject({ ok: true, restart: null });
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

    expect(startHandoff).toHaveBeenCalledTimes(1);
    expectHandoff({
      root: "/tmp/openclaw-global",
    });
  });

  it("delegates Git preflight to the same prepared updater while serving", async () => {
    const root = path.join(
      await fs.realpath(expectDefined(process.env.HOME, "fixture HOME")),
      "openclaw-git",
    );
    detectSupervisor.mockReturnValueOnce("launchd");
    mockGitInstallSurface(root);
    const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );

    expect(startHandoff).toHaveBeenCalledTimes(1);
    expectHandoff({
      root,
      handoffId: expect.any(String),
      supervisor: "launchd",
      meta: expect.objectContaining({
        handoffId: expect.any(String),
        root,
      }),
    });
    expect(scheduleRestart).not.toHaveBeenCalled();
    expect(transferHandoff).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({
      ok: true,
      result: { status: "skipped", reason: "managed-service-handoff-started", mode: "git" },
    });
    expect(payload?.handoff).toEqual({
      status: "started",
      pid: 12345,
      command: "openclaw update --yes --timeout 1800",
    });
    expect(readCapturedPayload().status).toBe("skipped");
  });

  it("keeps the serving Gateway when its prepared helper cannot start", async () => {
    detectSupervisor.mockReturnValueOnce("launchd");
    startHandoff.mockRejectedValueOnce(new Error("fixture helper import failed"));
    const payload = await captureUpdateRunPayload();
    expect(payload).toMatchObject({
      ok: false,
      result: { status: "error", reason: "managed-service-handoff-failed" },
    });
    expect(transferHandoff).not.toHaveBeenCalled();
    expect(scheduleRestart).not.toHaveBeenCalled();
  });

  it("does not pass the stored stable channel to supervised git handoff CLI", async () => {
    normalizeUpdateChannelMock.mockReturnValueOnce("stable");
    detectSupervisor.mockReturnValueOnce("launchd");
    mockGitInstallSurface("/tmp/openclaw-git");

    const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
      captureUpdateRunPayload(),
    );
    expect(startHandoff).toHaveBeenCalledTimes(1);
    expect(startHandoff.mock.calls[0]?.[0]).not.toHaveProperty("channel");
    expect(payload?.handoff?.command).not.toContain("--channel");
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

  it.each([
    {
      name: "Windows fallback",
      supervisor: "schtasks",
      root: "C:\\openclaw",
      env: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
    },
    {
      name: "systemd unit identity",
      supervisor: "systemd",
      root: "/tmp/openclaw-git",
      env: {
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
        INVOCATION_ID: "8a77e69a8f604bf0b7984879b9f17a7c",
      },
    },
    {
      name: "systemd marker-only identity",
      supervisor: "systemd",
      root: "/tmp/openclaw-git",
      env: {
        OPENCLAW_SYSTEMD_UNIT: undefined,
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
    },
  ] as const)(
    "hands $name Git updates to the helper for ownership verification",
    async ({ supervisor, root, env }) => {
      detectSupervisor.mockReturnValueOnce(supervisor);
      mockGitInstallSurface(root);
      const payload = await withEnvAsync(env, () => captureUpdateRunPayload());
      expect(startHandoff).toHaveBeenCalledOnce();
      expectHandoff({ root, supervisor, handoffId: expect.any(String) });
      expect(scheduleRestart).not.toHaveBeenCalled();
      expect(transferHandoff).toHaveBeenCalledOnce();
      expect(payload).toMatchObject({
        ok: true,
        handoff: { status: "started" },
        result: { status: "skipped", reason: "managed-service-handoff-started", mode: "git" },
      });
    },
  );

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
  it("keeps serving until the prepared updater requests parking, using the same transferred owner", async () => {
    normalizeUpdateChannelMock.mockReturnValueOnce("extended-stable");
    mockGitInstallSurface("/tmp/openclaw-git");
    const continuationMessage = "Check the running version and finish the update report.";
    const payload = await captureUpdateRunPayload({
      restartDelayMs: 7_000,
      timeoutMs: 1,
      continuationMessage,
    });
    expect(payload).toMatchObject({
      ok: true,
      sentinel: { persisted: true },
      handoff: { status: "started" },
      restart: null,
      result: { status: "skipped", reason: "managed-service-handoff-started" },
    });
    expect(startHandoff).toHaveBeenCalledOnce();
    const params = preparedHandoff();
    expect(params).toMatchObject({
      handoffId: expect.any(String),
      supervisor: null,
      root: "/tmp/openclaw-git",
      restartDelayMs: 7_000,
      timeoutMs: 1000,
      foregroundOrigin: { owner: "foreground-owner", pid: process.pid },
      meta: { completionOwner: "gateway-restart", runId: payload!.runId, continuationMessage },
    });
    expect(params).not.toHaveProperty("channel");
    expect(readCapturedPayload().continuation).toBeUndefined();
    expect(readCapturedPayload().deliveryContext).toBeUndefined();
    expect(recordSentinel.mock.invocationCallOrder[0]).toBeLessThan(
      transferHandoff.mock.invocationCallOrder[0]!,
    );
    expect(params.foregroundOrigin?.stateDatabasePath).toEqual(expect.any(String));
    expect(params.foregroundOrigin?.configPath).toEqual(expect.any(String));
    expect(transferHandoff.mock.calls[0]?.[0]).toMatchObject({ handoffId: params.handoffId });
    expect(scheduleRestart).not.toHaveBeenCalled();
    await params.beforePark?.();
    expect(scheduleRestart).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        delayMs: 0,
        reason: "update.run",
        successorOwner: transferHandoff.mock.calls[0]?.[0],
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
    const params = preparedHandoff();
    sendNotice.mockImplementationOnce(async () => {
      config.commands = { ownerAllowFrom: ["slack:OTHER"] };
      return true;
    });
    await expect(params.beforePark?.()).rejects.toThrow("authority changed");
    expect(scheduleRestart).not.toHaveBeenCalled();
  });

  it("keeps serving when its foreground helper loses its claim during the parking notice", async () => {
    await captureUpdateRunPayload({
      sessionKey: "agent:main:slack:dm:C0123ABC:thread:1234567890.123456",
      requester: { channel: "slack", senderId: "C0123ABC" },
    });
    const handoff = preparedHandoff();
    const notice = createDeferredCore<boolean>();
    const noticeStarted = createDeferredCore();
    sendNotice.mockImplementationOnce(() => {
      noticeStarted.resolve();
      return notice.promise;
    });
    const parking = handoff.beforePark?.();
    await noticeStarted.promise;
    claimHandoff.mockReturnValue(false);
    notice.resolve(true);
    await expect(parking).rejects.toThrow("authority changed");
    expect(scheduleRestart).not.toHaveBeenCalled();
  });

  it("does not hand off an unverified foreground process", async () => {
    readGatewayOwnerLeaseMock.mockReturnValueOnce(undefined);
    const payload = await captureUpdateRunPayload();
    expect(payload?.ok).toBe(false);
    expect(startHandoff).not.toHaveBeenCalled();
    expect(scheduleRestart).not.toHaveBeenCalled();
  });
});
