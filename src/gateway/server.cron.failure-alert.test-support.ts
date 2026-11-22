import path from "node:path";
import { expect, vi, type Mock, type MockInstance } from "vitest";
import type * as CronDelivery from "../cron/delivery.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { expectCronRows as rows } from "./server.cron.assertions.test-support.js";
import {
  cronIsolatedRun,
  prepareGatewayReplyRuntimeForTest,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

type FailureAlertClient = {
  request: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<{ ok: boolean; payload?: unknown }>;
  add: (
    name: string,
    options: {
      sessionTarget: "isolated";
      delivery: Record<string, unknown>;
      failureAlert: Record<string, unknown>;
    },
  ) => Promise<string>;
  run: (jobId: string) => Promise<unknown>;
};

export async function runCronFailureAlertOutcomeCase({
  signal,
  caseDir,
  startCronClient,
  cronNotifications,
  cronLogging,
  fetchWithSsrFGuardMock,
  sendCronAnnouncePayloadStrictMock,
}: {
  signal: AbortSignal;
  caseDir: string;
  startCronClient: () => Promise<FailureAlertClient>;
  cronNotifications: typeof import("./server-cron-notifications.js");
  cronLogging: typeof import("../logging.js");
  fetchWithSsrFGuardMock: { mockRejectedValueOnce: (error: Error) => unknown };
  sendCronAnnouncePayloadStrictMock: Mock<typeof CronDelivery.sendCronAnnouncePayloadStrict>;
}) {
  type Transport = typeof cronNotifications.sendGatewayCronFailureAlert;
  type Settled = Parameters<Transport>[0]["onDeliverySettled"];
  type Projection = {
    found: boolean;
    jobMatches: boolean;
    runMatches: boolean | null;
    alertMatches: boolean | null;
    delivered: boolean | null;
    status: "delivered" | "not-delivered" | "not-requested" | "unknown" | "absent";
    hasError: boolean;
  };
  const facts = (label: "delivered" | "failed" | "unreached") => ({
    label,
    announceEntered: 0,
    announceReturned: 0,
    views: {} as Partial<Record<"get" | "list" | "compact", Projection>>,
  });
  const diagnostics = new Map<
    string,
    {
      facts: ReturnType<typeof facts>;
      callbacks: MockInstance<Settled>[];
      runAtMs?: number;
      alertAtMs?: number;
    }
  >();
  const ownedSpies: { mockRestore: () => void }[] = [];
  const warnSpies: MockInstance<ReturnType<typeof cronLogging.toPinoLikeLogger>["warn"]>[] = [];
  let transportSpy: MockInstance<Transport> | undefined;
  signal.throwIfAborted();
  let active = true;
  const project = (jobId: string, value: unknown, view: "get" | "list" | "compact") => {
    const diagnostic = active ? diagnostics.get(jobId) : undefined;
    if (!diagnostic) {
      return;
    }
    const row = value as
      | {
          id?: unknown;
          lastRunAtMs?: unknown;
          state?: { lastFailureAlertAtMs?: unknown };
          lastFailureNotificationDelivered?: unknown;
          lastFailureNotificationDeliveryStatus?: unknown;
          lastFailureNotificationDeliveryError?: unknown;
        }
      | undefined;
    const status = row?.lastFailureNotificationDeliveryStatus;
    diagnostic.facts.views[view] = {
      found: row != null,
      jobMatches: row?.id === jobId,
      runMatches:
        diagnostic.runAtMs === undefined || typeof row?.lastRunAtMs !== "number"
          ? null
          : row.lastRunAtMs === diagnostic.runAtMs,
      alertMatches:
        diagnostic.alertAtMs === undefined || typeof row?.state?.lastFailureAlertAtMs !== "number"
          ? null
          : row.state.lastFailureAlertAtMs === diagnostic.alertAtMs,
      delivered:
        typeof row?.lastFailureNotificationDelivered === "boolean"
          ? row.lastFailureNotificationDelivered
          : null,
      status:
        status === "delivered" ||
        status === "not-delivered" ||
        status === "not-requested" ||
        status === "unknown"
          ? status
          : "absent",
      hasError: typeof row?.lastFailureNotificationDeliveryError === "string",
    };
  };
  const report = () => {
    const counters = () => ({ entered: 0, returned: 0, fulfilled: 0, rejected: 0, threw: 0 });
    const countCall = (
      count: ReturnType<typeof counters>,
      mock: Pick<MockInstance["mock"], "results" | "settledResults">,
      index: number,
    ) => {
      count.entered += 1;
      const result = mock.results[index];
      if (result?.type === "throw") {
        count.threw += 1;
      } else if (result?.type === "return") {
        count.returned += 1;
        // Vitest also records synchronous throws as settled rejections.
        const settled = mock.settledResults[index];
        if (settled?.type === "fulfilled") {
          count.fulfilled += 1;
        } else if (settled?.type === "rejected") {
          count.rejected += 1;
        }
      }
    };
    // Callback fulfillment is not proof of persistence; public projections omit notification IDs.
    // Keep only three known cases and fixed labels, never job IDs, paths, payloads, or errors.
    console.error(
      "[cron-failure-alert-diagnostic]",
      JSON.stringify(
        [...diagnostics].map(([jobId, diagnostic]) => {
          const transport = counters();
          const callback = counters();
          let outcome: Parameters<Settled>[0] | undefined;
          const transportMock = transportSpy?.mock;
          transportMock?.calls.forEach(([params], index) => {
            if (params.job.id === jobId) {
              countCall(transport, transportMock, index);
            }
          });
          for (const spy of diagnostic.callbacks) {
            for (const [index, [value]] of spy.mock.calls.entries()) {
              countCall(callback, spy.mock, index);
              outcome = value;
            }
          }
          const warnings = { persistenceWarnings: 0, transportWarnings: 0, otherWarnings: 0 };
          for (const spy of warnSpies) {
            for (const warning of spy.mock.calls) {
              const fields = warning[0] as { jobId?: unknown } | null;
              if (fields?.jobId === jobId) {
                const key =
                  warning[1] === "cron: failed to record failure-alert outcome"
                    ? "persistenceWarnings"
                    : warning[1] === "cron: failure alert delivery failed"
                      ? "transportWarnings"
                      : "otherWarnings";
                warnings[key] += 1;
              }
            }
          }
          return {
            label: diagnostic.facts.label,
            announceEntered: diagnostic.facts.announceEntered,
            announceReturned: diagnostic.facts.announceReturned,
            views: diagnostic.facts.views,
            transport,
            callback,
            callbackStatus: outcome?.status ?? "absent",
            callbackDelivered: outcome?.delivered ?? null,
            callbackHasError: typeof outcome?.error === "string",
            persistenceWarnings: warnings.persistenceWarnings,
            transportWarnings: warnings.transportWarnings,
            otherWarnings: warnings.otherWarnings,
          };
        }),
      ),
    );
  };
  // A timed-out Vitest body can remain suspended. Retire only this case's spies
  // synchronously, after recording their histories and before later cases run.
  const dispose = (failed = false) => {
    if (!active) {
      return;
    }
    active = false;
    signal.removeEventListener("abort", onAbort);
    try {
      if (failed) {
        report();
      }
    } finally {
      for (const spy of ownedSpies.toReversed()) {
        spy.mockRestore();
      }
    }
  };
  const onAbort = () => dispose(true);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const send = cronNotifications.sendGatewayCronFailureAlert;
    transportSpy = vi
      .spyOn(cronNotifications, "sendGatewayCronFailureAlert")
      .mockImplementation(function (this: unknown, params) {
        const diagnostic = active ? diagnostics.get(params.job.id) : undefined;
        if (!diagnostic) {
          return Reflect.apply(send, this, [params]);
        }
        diagnostic.runAtMs = params.job.state.lastRunAtMs;
        diagnostic.alertAtMs = params.job.state.lastFailureAlertAtMs;
        const callback = vi.spyOn(params, "onDeliverySettled");
        diagnostic.callbacks.push(callback);
        ownedSpies.push(callback);
        return Reflect.apply(send, this, [params]);
      });
    ownedSpies.push(transportSpy);
    const toLogger = cronLogging.toPinoLikeLogger;
    ownedSpies.push(
      vi.spyOn(cronLogging, "toPinoLikeLogger").mockImplementation(function (
        this: unknown,
        ...args
      ) {
        const logger: ReturnType<typeof toLogger> = Reflect.apply(toLogger, this, args);
        if (active) {
          const warn = vi.spyOn(logger, "warn");
          warnSpies.push(warn);
          ownedSpies.push(warn);
        }
        return logger;
      }),
    );
    // Delivery persistence is independent of cold fallback-session creation and runtime preparation.
    testState.sessionStorePath = path.join(caseDir, "sessions.json");
    await writeSessionStore({
      entries: { main: { sessionId: "cron-failure-alert-session", updatedAt: Date.now() } },
    });
    const { request, add, run } = await startCronClient();
    await prepareGatewayReplyRuntimeForTest({ force: true });

    const expectOutcome = async (jobId: string, expected: Record<string, unknown>) => {
      await vi.waitFor(async () => {
        const getResult = await request("cron.get", { id: jobId });
        project(jobId, getResult.payload, "get");
        expect(getResult.payload).toMatchObject(expected);
        for (const compact of [false, true]) {
          const listResult = await request("cron.list", {
            compact,
            includeDeliveryPreviews: false,
          });
          const listed = rows(listResult, "jobs").find((job) => job.id === jobId);
          project(jobId, listed, compact ? "compact" : "list");
          expect(listed).toMatchObject(expected);
        }
      });
    };
    const runFailureAlert = async (
      name: string,
      failureAlert: Record<string, unknown>,
      diagnosticFacts: ReturnType<typeof facts>,
    ) => {
      cronIsolatedRun.mockResolvedValueOnce({ status: "error", error: "job failed" });
      const jobId = await add(name, {
        sessionTarget: "isolated",
        delivery: { mode: "none" },
        failureAlert: { after: 1, ...failureAlert },
      });
      if (active) {
        diagnostics.set(jobId, { facts: diagnosticFacts, callbacks: [] });
      }
      await run(jobId);
      return jobId;
    };

    for (const outcome of ["delivered", "failed", "unreached"] as const) {
      const diagnosticFacts = facts(outcome);
      const error = outcome === "failed" ? "alert transport rejected" : "adapter_returned_no_send";
      if (outcome === "failed") {
        fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error(error));
      } else if (outcome === "unreached") {
        sendCronAnnouncePayloadStrictMock.mockImplementationOnce(async (params) => {
          if (active) {
            diagnosticFacts.announceEntered += 1;
          }
          params.onDeliveryAttempt?.(false);
          if (active) {
            diagnosticFacts.announceReturned += 1;
          }
          return { status: "suppressed", reason: "adapter_returned_no_send" };
        });
      }
      const jobId = await runFailureAlert(
        `${outcome} failure alert`,
        outcome === "unreached"
          ? { mode: "announce", channel: "telegram", to: "123" }
          : { mode: "webhook", to: `https://example.invalid/${outcome}-failure-alert` },
        diagnosticFacts,
      );
      await expectOutcome(jobId, {
        lastFailureNotificationDelivered: outcome === "delivered",
        lastFailureNotificationDeliveryStatus:
          outcome === "delivered" ? "delivered" : "not-delivered",
        ...(outcome === "delivered"
          ? {}
          : { lastFailureNotificationDeliveryError: expect.stringContaining(error) }),
      });
    }
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  } catch (error) {
    dispose(true);
    throw error;
  } finally {
    dispose();
  }
}
