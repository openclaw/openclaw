// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsDiffResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { watchedGateway } from "./gateway-stores.test-support.ts";
import { createSessionDiffSummary } from "./session-diff-summary.ts";

const result: SessionsDiffResult = {
  sessionKey: "agent:main:details",
  files: [{ path: "app.ts", status: "modified", additions: 248, deletions: 61 }],
  additions: 248,
  deletions: 61,
};
function harness() {
  const request = vi.fn().mockResolvedValue(result);
  const {
    gateway,
    publish: publishSnapshot,
    unsubscribe,
  } = watchedGateway({
    client: createTestGatewayClient(request),
    hello: null,
    selfUser: null,
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "agent:main:details",
    lastError: null,
    lastErrorCode: null,
  });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const owner = createSessionDiffSummary(document);
  const input = {
    gateway,
    sessionKey: "agent:main:details",
    agentId: "main",
    sessionId: "one",
    presented: true,
    runActive: false,
  };
  const update = (patch: Partial<typeof input> = {}) => {
    Object.assign(input, patch);
    owner.update(input);
  };
  const publish = (patch: Partial<ApplicationGatewaySnapshot>, newScope = false) => {
    if (newScope) {
      Object.defineProperty(gateway, "connectionRevision", {
        value: gateway.connectionRevision + 1,
        configurable: true,
      });
    }
    publishSnapshot({ ...gateway.snapshot, ...patch });
  };
  const visible = (value: "hidden" | "visible") => {
    visibility.mockReturnValue(value);
    document.dispatchEvent(new Event("visibilitychange"));
  };
  return { owner, update, request, publish, visible, unsubscribe, gateway };
}
const owners: Array<ReturnType<typeof harness>["owner"]> = [];
const create = () => {
  const h = harness();
  owners.push(h.owner);
  return h;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.dispose();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("Details summary observation", () => {
  it("requests metadata only while presented, paces active and idle work, and never catches up hidden intervals", async () => {
    const h = create();
    h.update({ presented: false });
    await settle();
    expect(h.request).not.toHaveBeenCalled();
    h.update();
    h.update({ presented: true });
    await settle();
    expect(h.request).toHaveBeenCalledExactlyOnceWith("sessions.diff", {
      sessionKey: "agent:main:details",
      agentId: "main",
      scope: "all",
      summaryOnly: true,
      poll: true,
    });
    expect(h.owner.snapshot.summary).toEqual({
      fileCount: 1,
      additions: 248,
      deletions: 61,
      truncated: false,
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request).toHaveBeenCalledTimes(2);
    h.update({ runActive: true });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request).toHaveBeenCalledTimes(3);
    h.visible("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.request).toHaveBeenCalledTimes(3);
    h.visible("visible");
    await settle();
    expect(h.request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.request).toHaveBeenCalledTimes(4);
    h.update({ presented: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.request).toHaveBeenCalledTimes(4);
    h.update({ presented: true });
    await settle();
    expect(h.request).toHaveBeenCalledTimes(5);
    h.publish({ phase: "reconnecting" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.request).toHaveBeenCalledTimes(5);
    expect(h.owner.snapshot.stale).toBe(true);
    h.publish({ phase: "connected" });
    await settle();
    expect(h.request).toHaveBeenCalledTimes(6);
  });

  it("keeps known values during a single slow refresh, retains them on failure, and recovers", async () => {
    const h = create();
    h.update();
    await settle();
    const pending = createDeferred<SessionsDiffResult>();
    h.request.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.owner.snapshot.summary?.additions).toBe(248);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.request).toHaveBeenCalledTimes(2);
    pending.resolve({ ...result, additions: 300, truncated: true });
    await settle();
    expect(h.owner.snapshot.summary).toMatchObject({ additions: 300, truncated: true });
    h.request.mockRejectedValueOnce(new Error("network failed"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.owner.snapshot).toMatchObject({ stale: true, summary: { additions: 300 } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.owner.snapshot).toMatchObject({ stale: false, summary: { additions: 248 } });
  });

  it("polls computing summaries without publishing zero and pauses with visible demand", async () => {
    const h = create();
    const computing = { ...result, computing: true, files: [], additions: 0, deletions: 0 };
    h.request.mockResolvedValueOnce(computing);
    h.update();
    await settle();
    expect(h.owner.snapshot).toMatchObject({ summary: null, unavailable: false });
    await vi.advanceTimersByTimeAsync(499);
    expect(h.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.owner.snapshot.summary?.additions).toBe(248);

    h.request.mockResolvedValue(computing);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.owner.snapshot.summary?.additions).toBe(248);
    h.visible("hidden");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.request).toHaveBeenCalledTimes(3);
    h.visible("visible");
    await settle();
    expect(h.request).toHaveBeenCalledTimes(4);
    h.update({ presented: false });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.request).toHaveBeenCalledTimes(4);
    h.request.mockResolvedValue(result);
    h.update({ sessionKey: "agent:main:replacement", presented: true });
    await settle();
    expect(h.owner.snapshot.summary?.additions).toBe(248);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.request).toHaveBeenCalledTimes(5);
  });

  it("keeps unknown and unavailable distinct from zero and returns a real zero summary", async () => {
    const h = create();
    h.request.mockRejectedValueOnce(new Error("offline"));
    h.update();
    await settle();
    expect(h.owner.snapshot).toMatchObject({ summary: null, unavailable: true });
    h.request.mockResolvedValueOnce({
      ...result,
      files: [],
      additions: 0,
      deletions: 0,
      unavailableReason: "not_git",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.owner.snapshot.summary).toBeNull();
    h.request.mockResolvedValueOnce({ ...result, files: [], additions: 0, deletions: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.owner.snapshot.summary).toMatchObject({ fileCount: 0, additions: 0, deletions: 0 });
  });

  it("isolates delayed results and cached values by session, agent, incarnation, and Gateway scope", async () => {
    const h = create();
    h.update();
    await settle();
    h.update({ sessionKey: "agent:main:other" });
    expect(h.owner.snapshot.summary).toBeNull();
    await settle();
    h.update({ sessionKey: "agent:main:details" });
    expect(h.owner.snapshot.summary?.additions).toBe(248);
    expect(h.request).toHaveBeenCalledTimes(2);
    const pending = createDeferred<SessionsDiffResult>();
    h.request.mockReturnValueOnce(pending.promise);
    h.update({ agentId: "other" });
    await settle();
    expect(h.owner.snapshot.summary).toBeNull();
    h.update({ sessionId: "two" });
    pending.resolve({ ...result, additions: 999 });
    await settle();
    expect(h.owner.snapshot.summary?.additions).toBe(248);
    expect(h.request.mock.calls.at(-1)?.[1]).toMatchObject({ agentId: "other" });
    h.publish({}, true);
    expect(h.owner.snapshot.summary).toBeNull();
    await settle();
    expect(h.owner.snapshot.summary?.additions).toBe(248);
    h.owner.dispose();
    expect(h.gateway.subscribe).toHaveBeenCalledOnce();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    const count = h.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.request).toHaveBeenCalledTimes(count);
  });
});
