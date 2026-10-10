import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { MsgContext } from "../auto-reply/templating.js";

type InboundRuntime = typeof import("../config/sessions/inbound.runtime.js");
const recordSessionMetaFromInboundMock = vi.fn(
  (_args: Parameters<InboundRuntime["recordInboundSessionMeta"]>[0]) => Promise.resolve(undefined),
);
const updateLastRouteMock = vi.fn(
  (_args: Parameters<InboundRuntime["updateSessionLastRoute"]>[0]) => Promise.resolve(undefined),
);

vi.mock("../config/sessions/inbound.runtime.js", () => ({
  recordInboundSessionMeta: (args: Parameters<InboundRuntime["recordInboundSessionMeta"]>[0]) =>
    recordSessionMetaFromInboundMock(args),
  updateSessionLastRoute: (args: Parameters<InboundRuntime["updateSessionLastRoute"]>[0]) =>
    updateLastRouteMock(args),
}));

type SessionModule = typeof import("./session.js");

let recordInboundSession: SessionModule["recordInboundSession"];

describe("recordInboundSession", () => {
  const ctx: MsgContext = {
    Provider: "demo-channel",
    From: "demo-channel:1234",
    SessionKey: "agent:main:demo-channel:1234:thread:42",
    OriginatingTo: "demo-channel:1234",
  };

  function record(overrides: Partial<Parameters<SessionModule["recordInboundSession"]>[0]>) {
    return recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:main:demo-channel:1234:thread:42",
      ctx,
      onRecordError: vi.fn(),
      ...overrides,
    });
  }

  beforeAll(async () => {
    ({ recordInboundSession } = await import("./session.js"));
  });

  beforeEach(() => {
    recordSessionMetaFromInboundMock.mockClear();
    updateLastRouteMock.mockClear();
  });

  it("settles metadata persistence before returning to the dispatcher", async () => {
    const started = createDeferred();
    const writer = createDeferred<undefined>();
    recordSessionMetaFromInboundMock.mockImplementationOnce(() => {
      started.resolve();
      return writer.promise;
    });
    const returned = vi.fn();
    const work = record({}).then(returned);
    try {
      await started.promise;
      await Promise.resolve();
      expect(returned).not.toHaveBeenCalled();
    } finally {
      writer.resolve(undefined);
      await work;
    }
    expect(returned).toHaveBeenCalledOnce();
  });

  it("tracks slow error reporting without holding dispatch after a failed write", async ({
    signal,
  }) => {
    const failure = new Error("metadata write failed");
    const reporter = createDeferred();
    const onRecordError = vi.fn(() => reporter.promise);
    const reported = vi.fn();
    let trackedTask: Promise<unknown> | undefined;
    recordSessionMetaFromInboundMock.mockRejectedValueOnce(failure);
    const work = record({
      onRecordError,
      trackSessionMetaTask: (task) => {
        trackedTask = task;
        void task.then(reported);
      },
    });
    try {
      await withinTest(work, signal);
      expect(onRecordError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(trackedTask).toBeInstanceOf(Promise);
      expect(reported).not.toHaveBeenCalled();
    } finally {
      reporter.reject(new Error("reporting failed"));
      await work;
      await trackedTask;
    }
    expect(reported).toHaveBeenCalledOnce();
  });

  it("rejects pending database admission before dispatch even when reporting fails", async () => {
    const { AgentDatabaseAdmissionError } = await import("../state/agent-database-admission.js");
    const failure = new AgentDatabaseAdmissionError({
      agentId: "main",
      paths: ["/tmp/openclaw-agent.sqlite"],
      code: "agent-database-inspection-pending",
      reason: "Startup preparation is pending",
      repairHint: "Wait for startup preparation to finish",
    });
    const onRecordError = vi.fn(() => {
      throw new Error("reporting failed");
    });
    let trackedTask: Promise<unknown> | undefined;
    recordSessionMetaFromInboundMock.mockRejectedValueOnce(failure);

    await expect(
      record({
        onRecordError,
        trackSessionMetaTask: (task) => {
          trackedTask = task;
        },
        updateLastRoute: {
          sessionKey: "agent:main:demo-channel:1234:thread:42",
          channel: "demo-channel",
          to: "demo-channel:1234",
        },
      }),
    ).rejects.toBe(failure);

    expect(onRecordError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(trackedTask).toBeDefined();
    await expect(trackedTask).resolves.toBeUndefined();
    expect(updateLastRouteMock).not.toHaveBeenCalled();
  });

  it("keeps terminal database admission metadata errors best effort", async () => {
    const { AgentDatabaseAdmissionError } = await import("../state/agent-database-admission.js");
    const failure = new AgentDatabaseAdmissionError({
      agentId: "main",
      paths: ["/tmp/openclaw-agent.sqlite"],
      code: "agent-database-inspection-failed",
      reason: "Startup preparation failed",
      repairHint: "Run openclaw doctor --fix",
    });
    const onRecordError = vi.fn();
    recordSessionMetaFromInboundMock.mockRejectedValueOnce(failure);

    await expect(record({ onRecordError })).resolves.toBeUndefined();
    expect(onRecordError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("does not pass ctx when updating a different session key", async () => {
    await record({
      updateLastRoute: {
        sessionKey: "agent:main:main",
        channel: "demo-channel",
        to: "demo-channel:1234",
      },
    });

    const route = updateLastRouteMock.mock.calls[0]?.[0];
    expect(route?.sessionKey).toBe("agent:main:main");
    expect(route?.ctx).toBeUndefined();
    expect(route?.deliveryContext?.channel).toBe("demo-channel");
    expect(route?.deliveryContext?.to).toBe("demo-channel:1234");
  });

  it("normalizes mixed-case session keys before recording and route updates", async () => {
    await record({
      sessionKey: "Agent:Main:Demo-Channel:1234:Thread:42",
      updateLastRoute: {
        sessionKey: "agent:main:demo-channel:1234:thread:42",
        channel: "demo-channel",
        to: "demo-channel:1234",
      },
    });

    expect(recordSessionMetaFromInboundMock.mock.calls[0]?.[0].sessionKey).toBe(
      "agent:main:demo-channel:1234:thread:42",
    );
    const route = updateLastRouteMock.mock.calls[0]?.[0];
    expect(route?.sessionKey).toBe("agent:main:demo-channel:1234:thread:42");
    expect(route?.ctx).toBe(ctx);
    expect(route?.deliveryContext?.channel).toBe("demo-channel");
    expect(route?.deliveryContext?.to).toBe("demo-channel:1234");
  });

  it("preserves Signal group ids before recording and route updates", async () => {
    const mixedGroupId = "VWATodkf2hc8zdOS76q9Tb0+5Bi522E03qLdaQ/9ypg=";
    const signalCtx: MsgContext = {
      Provider: "signal",
      ChatType: "group",
      From: `signal:group:${mixedGroupId}`,
      To: `signal:group:${mixedGroupId}`,
      SessionKey: `agent:main:signal:group:${mixedGroupId}`,
      OriginatingTo: `signal:group:${mixedGroupId}`,
    };

    await record({
      sessionKey: `Agent:Main:Signal:Group:${mixedGroupId}`,
      ctx: signalCtx,
      updateLastRoute: {
        sessionKey: `Agent:Main:Signal:Group:${mixedGroupId}`,
        channel: "signal",
        to: `signal:group:${mixedGroupId}`,
      },
    });

    expect(recordSessionMetaFromInboundMock.mock.calls[0]?.[0].sessionKey).toBe(
      `agent:main:signal:group:${mixedGroupId}`,
    );
    const route = updateLastRouteMock.mock.calls[0]?.[0];
    expect(route?.sessionKey).toBe(`agent:main:signal:group:${mixedGroupId}`);
    expect(route?.ctx).toBe(signalCtx);
  });

  it("skips last-route updates when main DM owner pin mismatches sender", async () => {
    const onSkip = vi.fn();

    await record({
      updateLastRoute: {
        sessionKey: "agent:main:main",
        channel: "demo-channel",
        to: "demo-channel:1234",
        mainDmOwnerPin: {
          ownerRecipient: "1234",
          senderRecipient: "9999",
          onSkip,
        },
      },
    });

    expect(updateLastRouteMock).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith({
      ownerRecipient: "1234",
      senderRecipient: "9999",
    });
  });

  it("forwards session creation policy to last-route updates", async () => {
    await record({
      createIfMissing: false,
      updateLastRoute: {
        sessionKey: "agent:main:main",
        channel: "demo-channel",
        to: "demo-channel:1234",
      },
    });

    expect(recordSessionMetaFromInboundMock.mock.calls[0]?.[0].createIfMissing).toBe(false);
    const route = updateLastRouteMock.mock.calls[0]?.[0];
    expect(route?.sessionKey).toBe("agent:main:main");
    expect(route?.createIfMissing).toBe(false);
  });

  it.each([
    {
      name: "throws synchronously",
      handler: (_err: unknown): never => {
        throw new Error("handler failed");
      },
    },
    {
      name: "returns a rejected promise",
      handler: (_err: unknown) => Promise.reject(new Error("handler failed")),
    },
  ])("settles the tracked meta task when onRecordError $name", async ({ handler }) => {
    const recordError = new Error("db failed");
    recordSessionMetaFromInboundMock.mockRejectedValueOnce(recordError);
    const onRecordError = vi.fn(handler);
    let trackedMetaTask: Promise<unknown> | undefined;

    await record({
      onRecordError,
      trackSessionMetaTask: (task) => {
        trackedMetaTask = task;
      },
    });

    expect(trackedMetaTask).toBeDefined();
    await expect(trackedMetaTask).resolves.toBeUndefined();
    expect(onRecordError).toHaveBeenCalledTimes(1);
    expect(onRecordError).toHaveBeenCalledWith(recordError);
  });
});
