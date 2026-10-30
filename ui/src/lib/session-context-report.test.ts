// @vitest-environment jsdom
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
} from "@openclaw/gateway-client/browser";
import { expect, it, onTestFinished, vi } from "vitest";
import type { SessionSystemPromptReport } from "../../../src/config/sessions/session-system-prompt-report.js";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { sessionContextReportsForGateway } from "./session-context-report.ts";

const target = {
  sessionKey: "agent:main:context",
  agentId: "main",
  sessionId: "incarnation",
  model: "example-model",
  provider: "example",
  used: 50000,
};
const report: SessionSystemPromptReport = {
  source: "run",
  generatedAt: 1,
  sessionId: target.sessionId,
  model: target.model,
  provider: target.provider,
  systemPrompt: { chars: 40000, projectContextChars: 16000, nonProjectContextChars: 24000 },
  injectedWorkspaceFiles: [],
  skills: { promptChars: 8000, entries: [] },
  tools: { listChars: 0, schemaChars: 12000, entries: [] },
};
const response = (value: SessionSystemPromptReport = report) => ({
  sessions: [{ key: target.sessionKey, sessionId: target.sessionId, contextWeight: value }],
});
function setup(...reads: Promise<ReturnType<typeof response>>[]) {
  const request = createGatewayRequestMock();
  for (const read of reads) {
    request.mockReturnValueOnce(read);
  }
  const { gateway, publish } = createApplicationGateway();
  const client = createTestGatewayClient(request);
  publish({ ...gateway.snapshot, phase: "connected", client });
  return { gateway, publish, request, store: sessionContextReportsForGateway(gateway) };
}

it("shares pending reads, cached tab return and explicit refresh while releasing final demand", async () => {
  const initial = createDeferredCore<ReturnType<typeof response>>();
  const updated = createDeferredCore<ReturnType<typeof response>>();
  const latest = createDeferredCore<ReturnType<typeof response>>();
  const retired = createDeferredCore<ReturnType<typeof response>>();
  const { request, store } = setup(initial.promise, updated.promise);
  const panel = {};
  const popover = {};
  store.watch(panel, target, false);
  expect(request).not.toHaveBeenCalled();
  store.watch(panel, target);
  store.watch(popover, { ...target });
  const first = store.refresh(target);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    key: target.sessionKey,
    agentId: "main",
    includeContextWeight: true,
  });
  initial.resolve(response());
  await first;
  expect(store.get(target).report).toEqual(report);
  store.watch(panel, target, false);
  store.watch(popover, target, false);
  store.watch(panel, target);
  expect(request).toHaveBeenCalledTimes(1);
  expect(store.get(target).report).toEqual(report);
  const nextTarget = { ...target, used: 51000 };
  store.watch(panel, nextTarget);
  store.watch(popover, nextTarget);
  const refresh = store.refresh(nextTarget);
  expect(store.refresh(nextTarget)).toBe(refresh);
  expect(request).toHaveBeenCalledTimes(2);
  expect(store.get(nextTarget).report).toEqual(report);
  request.mockReturnValueOnce(latest.promise);
  const finalTarget = { ...nextTarget, used: 53000 };
  store.watch(panel, { ...nextTarget, used: 52000 });
  store.watch(panel, finalTarget);
  store.watch(popover, finalTarget);
  expect(request).toHaveBeenCalledTimes(2);
  updated.resolve(response({ ...report, generatedAt: 2 }));
  await refresh;
  expect(request).toHaveBeenCalledTimes(3);
  expect(store.get(finalTarget).report).toEqual(report);
  const finalRead = store.refresh(finalTarget);
  latest.resolve(response({ ...report, generatedAt: 3 }));
  await finalRead;
  expect(store.get(finalTarget).report?.generatedAt).toBe(3);
  request.mockRejectedValueOnce(
    new GatewayProtocolRequestError({ code: "UNAVAILABLE", retryable: true }),
  );
  await store.refresh(finalTarget);
  expect(store.get(finalTarget)).toMatchObject({
    report: { generatedAt: 3 },
    failed: true,
    loading: false,
  });
  request.mockRejectedValueOnce(new GatewayProtocolRequestError({ code: "FORBIDDEN" }));
  await store.refresh(finalTarget);
  expect(store.get(finalTarget)).toMatchObject({ report: null, failed: true });
  request.mockReturnValueOnce(retired.promise);
  const pending = store.refresh(finalTarget);
  const signal = request.mock.calls[5]?.[2]?.signal;
  store.unwatch(panel);
  expect(signal?.aborted).toBe(false);
  store.unwatch(popover);
  expect(signal?.aborted).toBe(true);
  retired.resolve(response({ ...report, generatedAt: 3 }));
  await pending;
  expect(store.get(finalTarget).report).toBeNull();
});

it("fences a pending response across same-client reconnect and reloads only active readers", async () => {
  const old = createDeferredCore<ReturnType<typeof response>>();
  const fresh = createDeferredCore<ReturnType<typeof response>>();
  const { gateway, publish, request, store } = setup(old.promise, fresh.promise);
  const owner = {};
  store.watch(owner, target);
  const oldRead = store.refresh(target);
  const connected = gateway.snapshot;
  publish({ ...connected, phase: "reconnecting" });
  expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  expect(store.get(target)).toMatchObject({ report: null, offline: true, loading: false });
  publish(connected);
  const freshRead = store.refresh(target);
  expect(request).toHaveBeenCalledTimes(2);
  old.resolve(response());
  await oldRead;
  expect(store.get(target).report).toBeNull();
  expect(store.get(target).loading).toBe(true);
  fresh.resolve(response({ ...report, generatedAt: 2 }));
  await freshRead;
  expect(store.get(target).report?.generatedAt).toBe(2);
  store.watch(owner, target, false);
  publish({ ...connected, phase: "reconnecting" });
  publish(connected);
  expect(request).toHaveBeenCalledTimes(2);
  store.unwatch(owner);
});

it.each(["sessionId", "model", "provider"] as const)(
  "does not cache a report for a different %s as current usage",
  async (field) => {
    const { store, request } = setup();
    request.mockResolvedValue(response({ ...report, [field]: "other" }));
    const owner = {};
    store.watch(owner, target);
    await store.refresh(target);
    expect(store.get(target)).toEqual({
      report: null,
      loading: false,
      failed: false,
      offline: false,
    });
    store.watch(owner, target, false);
    store.watch(owner, target);
    expect(request).toHaveBeenCalledTimes(1);
    store.unwatch(owner);
  },
);

it("recovers once for two consumers and preserves server backoff while demand is paused", async () => {
  vi.useFakeTimers();
  const { store, request } = setup();
  request
    .mockRejectedValueOnce(
      new GatewayProtocolRequestError({ code: "UNAVAILABLE", retryable: true }),
    )
    .mockRejectedValueOnce(
      new GatewayProtocolRequestTimeoutError({
        method: "sessions.usage",
        timeoutMs: 30_000,
        requestSent: true,
      }),
    )
    .mockResolvedValue(response());
  const panel = {};
  const popover = {};
  onTestFinished(() => {
    store.unwatch(panel);
    store.unwatch(popover);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  store.watch(panel, target);
  store.watch(popover, target);
  await store.refresh(target);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(request).toHaveBeenCalledTimes(3);
  expect(store.get(target).report).toEqual(report);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(request).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);

  const held = createDeferredCore<ReturnType<typeof response>>();
  request.mockReturnValueOnce(held.promise);
  const refresh = store.refresh(target);
  const latest = { ...target, used: target.used + 100 };
  store.watch(panel, latest);
  store.watch(popover, latest);
  held.reject(
    new GatewayProtocolRequestError({
      code: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 600_000,
    }),
  );
  await refresh;
  expect(request).toHaveBeenCalledTimes(4);
  expect(store.get(latest).report).toEqual(report);
  store.watch(panel, latest, false);
  expect(vi.getTimerCount()).toBe(1);
  store.watch(popover, latest, false);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(300_000);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  store.watch(panel, latest);
  await vi.advanceTimersByTimeAsync(200_000);
  expect(request).toHaveBeenCalledTimes(4);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(99_999);
  expect(request).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledTimes(5);
  expect(store.get(latest)).toMatchObject({ report, failed: false });
  for (const state of ["hidden", "visible"] as const) {
    visibility.mockReturnValue(state);
    document.dispatchEvent(new Event("visibilitychange"));
  }
  await vi.advanceTimersByTimeAsync(600_000);
  expect(request).toHaveBeenCalledTimes(5);
  expect(vi.getTimerCount()).toBe(0);
});
