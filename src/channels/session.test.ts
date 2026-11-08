import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { recordInboundSession } from "./session.js";

type InboundRuntime = typeof import("../config/sessions/inbound.runtime.js");
const { recordMeta, updateRoute } = vi.hoisted(() => ({
  recordMeta: vi.fn<InboundRuntime["recordInboundSessionMeta"]>(),
  updateRoute: vi.fn<InboundRuntime["updateSessionLastRoute"]>(),
}));

// mock-isolation: routing assertions record writes without opening durable session stores.
vi.mock("../config/sessions/inbound.runtime.js", () => ({
  recordInboundSessionMeta: recordMeta,
  updateSessionLastRoute: updateRoute,
}));

describe("recordInboundSession", () => {
  const sessionKey = "agent:main:demo-channel:1234:thread:42";
  const route = { sessionKey: "agent:main:main", channel: "demo-channel", to: "demo-channel:1234" };
  function record(overrides: Partial<Parameters<typeof recordInboundSession>[0]> = {}) {
    return recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey,
      ctx: { SessionKey: sessionKey },
      onRecordError: vi.fn(),
      ...overrides,
    });
  }

  async function admissionFailure(pending: boolean) {
    const { AgentDatabaseAdmissionError } = await import("../state/agent-database-admission.js");
    return new AgentDatabaseAdmissionError({
      agentId: "main",
      paths: ["/tmp/openclaw-agent.sqlite"],
      code: pending ? "agent-database-inspection-pending" : "agent-database-inspection-failed",
      reason: pending ? "Startup preparation is pending" : "Startup preparation failed",
      repairHint: pending ? "Wait for startup preparation to finish" : "Run openclaw doctor --fix",
    });
  }

  beforeEach(() => {
    recordMeta.mockReset().mockResolvedValue(null);
    updateRoute.mockReset().mockResolvedValue(null);
  });

  it("settles metadata persistence before returning to the dispatcher", async () => {
    const started = createDeferred();
    const writer = createDeferred<null>();
    recordMeta.mockImplementationOnce(() => {
      started.resolve();
      return writer.promise;
    });
    const returned = vi.fn();
    const work = record().then(returned);
    try {
      await started.promise;
      await Promise.resolve();
      expect(returned).not.toHaveBeenCalled();
    } finally {
      writer.resolve(null);
      await work;
    }
    expect(returned).toHaveBeenCalledOnce();
  });

  it("tracks slow reporting without blocking failed-write dispatch", async ({ signal }) => {
    const failure = new Error("metadata write failed");
    const reporter = createDeferred();
    const onRecordError = vi.fn(() => reporter.promise);
    const reported = vi.fn();
    const trackSessionMetaTask = vi.fn((task: Promise<unknown>) => void task.then(reported));
    recordMeta.mockRejectedValueOnce(failure);
    const work = record({ onRecordError, trackSessionMetaTask });
    try {
      await withinTest(work, signal);
      expect(onRecordError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(trackSessionMetaTask.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
      expect(reported).not.toHaveBeenCalled();
    } finally {
      reporter.reject(new Error("reporting failed"));
      await work;
      await trackSessionMetaTask.mock.calls[0]?.[0];
    }
    expect(reported).toHaveBeenCalledOnce();
  });

  it.each([true, false])("handles pending database admission (%s)", async (pending) => {
    const failure = await admissionFailure(pending);
    const onRecordError = vi.fn(() => {
      if (pending) {
        throw new Error("reporting failed");
      }
    });
    const trackSessionMetaTask = vi.fn<(task: Promise<unknown>) => void>();
    recordMeta.mockRejectedValueOnce(failure);
    const work = record({
      onRecordError,
      trackSessionMetaTask,
      createIfMissing: false,
      updateLastRoute: route,
    });
    if (pending) {
      await expect(work).rejects.toBe(failure);
      expect(updateRoute).not.toHaveBeenCalled();
    } else {
      await expect(work).resolves.toBeUndefined();
      expect(recordMeta.mock.calls[0]?.[0].createIfMissing).toBe(false);
      expect(updateRoute.mock.calls[0]?.[0]).toMatchObject({
        sessionKey: route.sessionKey,
        createIfMissing: false,
        ctx: undefined,
      });
    }
    expect(onRecordError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(trackSessionMetaTask).toHaveBeenCalledOnce();
    await expect(trackSessionMetaTask.mock.calls[0]?.[0]).resolves.toBeUndefined();
  });

  it("preserves Signal group ids before recording and route updates", async () => {
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    const group = `signal:group:${mixedGroupId}`;
    const key = `agent:main:${group}`;
    const mixedKey = `Agent:Main:Signal:Group:${mixedGroupId}`;
    const signalCtx: MsgContext = { Provider: "signal", From: group, SessionKey: key };

    await record({
      sessionKey: mixedKey,
      ctx: signalCtx,
      updateLastRoute: { sessionKey: mixedKey, channel: "signal", to: group },
    });

    expect(recordMeta.mock.calls[0]?.[0].sessionKey).toBe(key);
    expect(updateRoute.mock.calls[0]?.[0].sessionKey).toBe(key);
    expect(updateRoute.mock.calls[0]?.[0].ctx).toBe(signalCtx);
  });

  it("skips last-route updates when main DM owner pin mismatches sender", async () => {
    const onSkip = vi.fn();
    const recipients = { ownerRecipient: "1234", senderRecipient: "9999" };
    await record({
      updateLastRoute: { ...route, mainDmOwnerPin: { ...recipients, onSkip } },
    });

    expect(updateRoute).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith(recipients);
  });
});
