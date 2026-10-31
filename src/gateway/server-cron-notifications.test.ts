import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred as createVoidDeferred,
} from "../../test/helpers/promise.js";
import type { CliDeps } from "../cli/deps.types.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../cron/agent-id.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import type * as deliveryTarget from "../cron/isolated-agent/delivery-target.js";
import type { CronJob } from "../cron/types.js";
import type { GuardedFetchOptions } from "../infra/net/fetch-guard.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard:
    vi.fn<(request: GuardedFetchOptions) => Promise<ReturnType<typeof webhookResponse>>>(),
  sendCronAnnouncePayloadStrict: vi.fn(),
  commitCronConversationResult:
    vi.fn<typeof import("../cron/conversation-result.js").commitCronConversationResult>(),
  loadGatewaySessionEntryReadOnlyInWorker: vi.fn(async () => ({
    entry: { sessionId: "owner-session" },
  })),
  resolveDeliveryTarget: vi.fn<typeof deliveryTarget.resolveDeliveryTarget>(
    async (_cfg, _agentId, target) => ({
      ok: true,
      channel: target.channel ?? "discord",
      to: target.to ?? "channel:ops",
      accountId: target.accountId,
      threadId: target.threadId,
      mode: "explicit",
    }),
  ),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("../cron/delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/delivery.js")>();
  return {
    ...actual,
    sendCronAnnouncePayloadStrict: mocks.sendCronAnnouncePayloadStrict,
  };
});

vi.mock("../cron/isolated-agent/delivery-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof deliveryTarget>()),
  resolveDeliveryTarget: mocks.resolveDeliveryTarget,
}));

vi.mock("../cron/conversation-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cron/conversation-result.js")>()),
  commitCronConversationResult: mocks.commitCronConversationResult,
}));

vi.mock("./session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: mocks.loadGatewaySessionEntryReadOnlyInWorker,
}));

import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronFailureAlert as sendGatewayCronFailureAlertBase,
} from "./server-cron-notifications.js";

type FailureAlertParams = Parameters<typeof sendGatewayCronFailureAlertBase>[0];
const onDeliverySettled = vi.fn(async () => {});
const sendGatewayCronFailureAlert = (params: Partial<FailureAlertParams>) =>
  sendGatewayCronFailureAlertBase({
    job: createCompletionWebhookJob(),
    channel: "discord",
    to: "channel:ops",
    mode: "announce",
    deps: {} as CliDeps,
    logger: { warn: vi.fn() },
    resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    payload: { text: "cron failed" },
    routing: { defaultAgentId: "main" },
    onDeliverySettled,
    ...params,
  });

function webhookResponse(
  response = new Response(null, { status: 204 }),
  release = vi.fn(async () => {}),
) {
  return { response, release, finalUrl: "https://example.invalid/cron" };
}

function sendFailureWebhook(params: Partial<FailureAlertParams> = {}) {
  return sendGatewayCronFailureAlert({
    job: createWebhookJob({ mode: "webhook", to: "https://example.invalid/cron" }),
    channel: "last",
    mode: "webhook",
    to: "https://example.invalid/cron",
    ...params,
  });
}

function announceJob(channel = "discord") {
  return createWebhookJob({ mode: "announce", channel, to: "channel:ops" });
}

function sentFailureAlert() {
  return {
    status: "sent" as const,
    results: [],
    receipt: { primaryPlatformMessageId: undefined, platformMessageIds: [], parts: [], sentAt: 0 },
  };
}

function waitForFast(assertion: () => void | Promise<void>) {
  return vi.waitFor(assertion, { interval: 1 });
}

function expectSettlement(
  status: "delivered" | "not-delivered" | "unknown" = "delivered",
  error?: string,
) {
  expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith({
    delivered: status === "unknown" ? undefined : status === "delivered",
    status,
    ...(error === undefined ? {} : { error }),
  });
}

function webhookRequestBody() {
  const body = mocks.fetchWithSsrFGuard.mock.calls[0]?.[0].init?.body;
  if (typeof body !== "string") {
    throw new Error("expected webhook request body");
  }
  return JSON.parse(body);
}

function createWebhookJob(delivery: NonNullable<CronJob["delivery"]>): CronJob {
  return makeCronJob({ delivery });
}

function createCompletionWebhookJob(url = "https://example.invalid/cron"): CronJob {
  return createWebhookJob({
    mode: "announce",
    completionDestination: { mode: "webhook", to: url },
  });
}

const webhookSsrfPolicy = { allowedHostnames: ["127.0.0.1"] };
function dispatchCompletion(
  job: CronJob,
  overrides: Partial<Parameters<typeof dispatchGatewayCronFinishedNotifications>[0]> = {},
) {
  dispatchGatewayCronFinishedNotifications({
    evt: { jobId: job.id, action: "finished", status: "ok", summary: "done" },
    job,
    logger: { warn: vi.fn() },
    ...overrides,
  });
}

const runAtMs = Date.parse("2026-01-15T15:30:00.000Z");
const presentation = { blocks: [{ type: "text" as const, text: "Recovery guidance" }] };

const sensitiveSummary =
  "action-required output preserved:\nVisit www.example.com/device and enter code 123456\nLog in with token=opaque-secret-value";

const diagnostics = {
  summary: sensitiveSummary,
  entries: [
    { ts: 1, source: "exec" as const, severity: "warn" as const, message: sensitiveSummary },
  ],
};
function commandJob() {
  return {
    ...createCompletionWebhookJob(),
    payload: { kind: "command" as const, argv: ["echo", "ok"] },
    state: { lastDiagnosticSummary: sensitiveSummary, lastDiagnostics: diagnostics },
  };
}

function expectSecretsRedacted(text: string) {
  for (const secret of ["www.example.com/device", "123456", "opaque-secret-value"]) {
    expect(text).not.toContain(secret);
  }
}

describe("dispatchGatewayCronFinishedNotifications", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    mocks.fetchWithSsrFGuard.mockImplementation(async () => webhookResponse());
    mocks.sendCronAnnouncePayloadStrict.mockResolvedValue(sentFailureAlert());
    mocks.commitCronConversationResult.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetGatewayWorkAdmission();
    setActiveDegradedSecretOwners([]);
  });

  it.each([
    { name: "quiet trigger", status: "skipped", quietTrigger: true, notice: false },
    { name: "unstarted skip", status: "skipped", quietTrigger: false, notice: true },
    { name: "unstarted error", status: "error", quietTrigger: false, notice: true },
  ] as const)(
    "keeps the $name conversation outcome separate from its completion webhook",
    async ({ status, quietTrigger, notice }) => {
      const job = createCompletionWebhookJob();
      job.sessionKey = "agent:main:owner";
      const logger = { warn: vi.fn() };
      const evt = {
        jobId: job.id,
        action: "finished" as const,
        status,
        completionStatus: "failed" as const,
        runAtMs,
        error: "The payload did not run.",
      };
      dispatchCompletion(job, {
        evt,
        runNotStarted: true,
        quietTrigger,
        resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
        logger,
      });

      await waitForFast(() => {
        expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });
      expect(webhookRequestBody()).toMatchObject(evt);
      expect(mocks.commitCronConversationResult).toHaveBeenCalledTimes(notice ? 1 : 0);
      if (notice) {
        expect(mocks.commitCronConversationResult).toHaveBeenCalledWith(
          expect.objectContaining({
            conversation: { sessionKey: "agent:main:owner", sessionId: "owner-session" },
            payloads: [{ text: expect.stringContaining("did not start") }],
          }),
        );
      }
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["captured default", undefined, "alpha", "alpha"],
    ["explicit job owner", "gamma", "alpha", "gamma"],
    ["captured absence", undefined, undefined, undefined],
  ])(
    "routes a failure alert using %s instead of the live default",
    async (_name, jobAgentId, defaultAgentId, recipient) => {
      const job = announceJob();
      job.agentId = jobAgentId;
      job.sessionKey = "agent:session-owner:main";
      const resolveCronAgent = vi.fn((requested?: string | null) => ({
        agentId: requested ?? "beta",
        cfg: {},
      }));
      const target = {
        channel: "discord",
        to: "resolved-channel",
        accountId: "resolved-account",
        threadId: 7,
      };
      if (recipient) {
        mocks.resolveDeliveryTarget.mockResolvedValueOnce({
          ok: true,
          ...target,
          mode: "explicit",
        });
      }
      const delivery = sendGatewayCronFailureAlert({
        resolveCronAgent,
        job,
        routing: defaultAgentId ? { defaultAgentId } : {},
        accountId: "requested-account",
        threadId: 42,
      });
      if (recipient) {
        await delivery;
        expect(mocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: recipient,
            target: expect.objectContaining(target),
          }),
        );
        expectSettlement();
      } else {
        await expect(delivery).rejects.toThrow(CRON_AGENT_SELECTION_REQUIRED_MESSAGE);
        await expect(delivery).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
        expect(resolveCronAgent).not.toHaveBeenCalled();
        expect(mocks.resolveDeliveryTarget).not.toHaveBeenCalled();
        expect(mocks.sendCronAnnouncePayloadStrict).not.toHaveBeenCalled();
        expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
        expectSettlement("not-delivered", CRON_AGENT_SELECTION_REQUIRED_MESSAGE);
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );

  it("records non-delivery when admission refuses a failure alert", async () => {
    markGatewayRestartDraining();
    await expect(sendGatewayCronFailureAlert({})).rejects.toThrow("Gateway is restarting");
    expectSettlement("not-delivered", "Gateway is restarting. Please try again shortly.");
    expect(mocks.sendCronAnnouncePayloadStrict).not.toHaveBeenCalled();
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("settles already-admitted cron notifications while draining rejects unrelated work", async () => {
    const webhookDelivery = createVoidDeferred();
    const failureDelivery = createVoidDeferred();
    const settlement = createVoidDeferred();
    const persistSettlement = vi.fn(() => settlement.promise);
    mocks.fetchWithSsrFGuard.mockImplementationOnce(async () => {
      await webhookDelivery.promise;
      return webhookResponse();
    });
    mocks.sendCronAnnouncePayloadStrict.mockImplementationOnce(async () => {
      await failureDelivery.promise;
      return sentFailureAlert();
    });
    const job = createCompletionWebhookJob();
    const parentAdmission = tryBeginGatewayRootWorkAdmission();
    if (!parentAdmission) {
      throw new Error("expected parent Gateway work admission");
    }
    const suspensionAdmission = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspensionAdmission?.drain()).toBe(true);

    try {
      let failureAlert: Promise<void> | undefined;
      await parentAdmission.run(async () => {
        dispatchCompletion(job);
        failureAlert = sendGatewayCronFailureAlert({ job, onDeliverySettled: persistSettlement });
        await waitForFast(() => {
          expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
          expect(mocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledOnce();
        });
        expect(getActiveGatewayRootWorkCount()).toBe(3);
      });
      parentAdmission.release();

      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      expect(getActiveGatewayRootWorkCount()).toBe(2);
      webhookDelivery.resolve();
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(1));
      failureDelivery.resolve();
      await waitForFast(() => expect(persistSettlement).toHaveBeenCalledOnce());
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      settlement.resolve();
      await failureAlert;
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
    } finally {
      webhookDelivery.resolve();
      failureDelivery.resolve();
      settlement.resolve();
      parentAdmission.release();
      suspensionAdmission?.release();
    }
  });

  it.each(["unavailable token", "HTTP 500"] as const)(
    "reports completion webhook failure for %s",
    async (failure) => {
      const unavailable = failure === "unavailable token";
      const logger = { warn: vi.fn() };
      const release = vi.fn(async () => {});
      const job = createCompletionWebhookJob(
        unavailable ? undefined : "https://example.invalid/cron?token=must-not-be-logged",
      );
      if (unavailable) {
        setActiveDegradedSecretOwners([
          {
            ownerKind: "capability",
            ownerId: "cron-webhook",
            state: "unavailable",
            paths: ["cron.webhookToken"],
            refKeys: ["env:default:MISSING_WEBHOOK_TOKEN"],
            reason: "secret provider failed",
          },
        ]);
      } else {
        mocks.fetchWithSsrFGuard.mockResolvedValueOnce(
          webhookResponse(new Response(null, { status: 500 }), release),
        );
      }
      dispatchCompletion(job, { logger });
      await waitForFast(() =>
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            err: expect.stringContaining(unavailable ? "Secret owner" : "500"),
          }),
          "cron: webhook delivery failed",
        ),
      );
      if (unavailable) {
        expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
      } else {
        expect(release).toHaveBeenCalledOnce();
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("must-not-be-logged");
      }
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    },
  );

  it.each([false, true])("releases an unread webhook response (stalled=%s)", async (stalled) => {
    vi.useFakeTimers();
    const cleanupOrder: string[] = [];
    const release = vi.fn(async () => {
      cleanupOrder.push("release");
    });
    const response = new Response(
      new ReadableStream({
        cancel() {
          cleanupOrder.push("cancel");
          return stalled ? new Promise<void>(() => {}) : undefined;
        },
      }),
      { status: 200 },
    );
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce(webhookResponse(response, release));
    const delivery = sendFailureWebhook();
    if (stalled) {
      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    }
    await expect(delivery).resolves.toBeUndefined();
    expect(cleanupOrder).toEqual(["cancel", "release"]);
    expect(release).toHaveBeenCalledOnce();
    expectSettlement();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { name: "missing", to: undefined },
    { name: "invalid", to: "ftp://example.invalid/failure" },
  ])("rejects a $name failure-alert webhook target", async ({ to }) => {
    await expect(
      sendGatewayCronFailureAlert({ channel: "last", mode: "webhook", to }),
    ).rejects.toThrow(/webhook requires/);
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it.each([
    { phase: "dispatch", failure: "timeout", status: "unknown" },
    { phase: "response", failure: "http", status: "not-delivered" },
  ] as const)(
    "settles a failure-alert webhook $failure error after $phase as $status",
    async ({ phase, failure, status }) => {
      const error = Object.assign(new Error("webhook response timed out"), {
        name: "TimeoutError",
      });
      const errorMessage =
        failure === "http" ? "Webhook request failed with HTTP 500" : error.message;
      mocks.fetchWithSsrFGuard.mockImplementationOnce(async (request) => {
        request.beforeRequest?.();
        if (phase === "response") {
          request.onResponse?.(500);
          return {
            ...webhookResponse(new Response(null, { status: 500 })),
            finalUrl: "https://example.invalid/failure",
          };
        }
        throw error;
      });

      await expect(sendFailureWebhook({ to: "https://example.invalid/failure" })).rejects.toThrow(
        errorMessage,
      );
      expectSettlement(status, errorMessage);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );

  it.each(["failed", "succeeded"] as const)(
    "completion without a summary (%s)",
    async (completionStatus) => {
      const failed = completionStatus === "failed";
      const job = createCompletionWebhookJob();
      const logger = { warn: vi.fn() };
      const evt = {
        jobId: job.id,
        action: "finished" as const,
        status: "ok" as const,
        completionStatus,
        ...(failed
          ? { deliveryStatus: "not-delivered" as const, deliveryError: "channel unavailable" }
          : {}),
      };
      dispatchGatewayCronFinishedNotifications({ evt, job, logger, ssrfPolicy: webhookSsrfPolicy });
      if (failed) {
        await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce());
        expect(webhookRequestBody()).toMatchObject(evt);
        expect(logger.warn).not.toHaveBeenCalled();
      } else {
        expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "releases stalled failure alert admission (recipientReached=%s)",
    async (recipientReached) => {
      vi.useFakeTimers();
      let deliverySignal: AbortSignal | undefined;
      const senderEntered = createVoidDeferred();
      mocks.sendCronAnnouncePayloadStrict.mockImplementationOnce(
        ({
          abortSignal,
          onDeliveryAttempt: reportDeliveryAttempt,
        }: {
          abortSignal: AbortSignal;
          onDeliveryAttempt?: (reachedRecipient: boolean) => void;
        }) =>
          new Promise<void>(() => {
            deliverySignal = abortSignal;
            if (recipientReached) {
              reportDeliveryAttempt?.(true);
            }
            senderEntered.resolve();
          }),
      );
      const delivery = sendGatewayCronFailureAlert({ job: announceJob() });
      const deliveryOutcome = delivery.then(
        () => undefined,
        (error: unknown) => error,
      );

      await awaitGateBeforeSettlement(
        senderEntered.promise,
        delivery,
        "failure alert settled before entering the stalled sender",
      );
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(deliverySignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      expect(deliverySignal?.aborted).toBe(false);
      expect(onDeliverySettled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(deliverySignal?.aborted).toBe(true);
      await expect(deliveryOutcome).resolves.toEqual(
        expect.objectContaining({ message: "cron: failure alert announcement timed out" }),
      );
      expectSettlement(
        recipientReached ? "unknown" : "not-delivered",
        "cron: failure alert announcement timed out",
      );
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("defers detached completion delivery while suspension is prepared", async () => {
    const job = createCompletionWebhookJob();
    const suspensionAdmission = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspensionAdmission?.commit()).toBe(true);

    dispatchCompletion(job);

    await Promise.resolve();
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    expect(suspensionAdmission?.release()).toBe(true);
    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1));
  });

  it("rejects credential-bearing completion webhook targets before fetch", () => {
    const logger = { warn: vi.fn() };
    const credentialUrl = new URL("https://example.invalid/hook?token=placeholder");
    credentialUrl.username = "user";
    credentialUrl.password = "password";
    const job = createCompletionWebhookJob(credentialUrl.href);
    dispatchCompletion(job, {
      evt: { jobId: job.id, action: "finished", status: "ok" },
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      {
        jobId: job.id,
        deliveryTo: "https://example.invalid/hook",
      },
      "cron: skipped completion webhook delivery, delivery.completionDestination.to must be a valid http(s) URL",
    );
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it.each(["ok", "error"] as const)(
    "sanitizes command completion webhook output (%s)",
    async (status) => {
      const failed = status === "error";
      const job = commandJob();
      dispatchCompletion(job, {
        evt: {
          jobId: job.id,
          action: "finished",
          status,
          ...(failed ? { error: "command exited with code 7" } : {}),
          summary: sensitiveSummary,
          diagnostics,
          job,
        },
      });
      await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce());
      const body = webhookRequestBody();
      if (failed) {
        expect(body).toMatchObject({
          action: "finished",
          jobId: job.id,
          status: "error",
          error: "command exited with code 7",
        });
        expect(body).not.toHaveProperty("summary");
        expect(body).not.toHaveProperty("diagnostics");
        expectSecretsRedacted(JSON.stringify(body));
      } else {
        expect(body.diagnostics.summary).toBe(body.summary);
        for (const text of [body.summary, body.diagnostics.entries[0].message]) {
          for (const marker of ["[redacted-url]", "[redacted-code]", "token=***"]) {
            expect(text).toContain(marker);
          }
          expectSecretsRedacted(text);
        }
      }
      expect(body.job.state).not.toHaveProperty("lastDiagnosticSummary");
      expect(body.job.state).not.toHaveProperty("lastDiagnostics");
    },
  );

  it("keeps failure webhook messages stable and adds structured runAtMs", async () => {
    const job = createCompletionWebhookJob();
    await sendFailureWebhook({
      runAtMs,
      resolveCronAgent: () => ({
        agentId: "main",
        cfg: { agents: { defaults: { userTimezone: "America/New_York" } } },
      }),
      job,
      ssrfPolicy: webhookSsrfPolicy,
    });

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({ policy: webhookSsrfPolicy }),
    );
    expect(webhookRequestBody()).toEqual({
      jobId: job.id,
      jobName: job.name,
      message: "cron failed",
      runAtMs,
    });
  });

  it("composes failure alert details without dropping presentation", async () => {
    const gateway = {
      publicOrigin: "https://gateway.example",
      controlUi: { basePath: "/control" },
    };
    const expectedText = "cron failed\nRun started: 2026-01-15 10:30 EST";
    const inspectionUrl =
      "https://gateway.example/control/automations?job=job-1&run=cron%3Ajob-1%3A1768491000000";
    await sendGatewayCronFailureAlert({
      runAtMs,
      resolveCronAgent: () => ({
        agentId: "main",
        cfg: { agents: { defaults: { userTimezone: "America/New_York" } }, gateway },
      }),
      job: announceJob("telegram"),
      payload: {
        text: "cron failed",
        presentation: structuredClone(presentation),
      },
      channel: "telegram",
      to: "channel:ops",
    });

    expect(mocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          text: expectedText,
          presentation,
        },
        inspectionUrl,
      }),
    );
  });
});
