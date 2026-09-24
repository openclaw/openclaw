import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createNativeNotificationsCapability } from "../../app/native-notifications.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import * as toast from "../../lib/toast.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

function nativeBackgroundFixture(options: Parameters<typeof createDraftFixture>[0] = {}) {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", {
    messageHandlers: { openclawNotifications: { postMessage } },
  });
  const nativeNotifications = createNativeNotificationsCapability();
  const fixture = createDraftFixture(options);
  Object.assign(fixture.context, { nativeNotifications, basePath: "" });
  vi.mocked(fixture.context.sessions.createResult).mockResolvedValue({
    key: "agent:main:dashboard:background",
    initialRun: { status: "started", runId: "run-background" },
  });
  fixture.flow.setMessage("finish in the background");
  return { ...fixture, postMessage, dispose: () => nativeNotifications?.dispose() };
}

function failedPlacement(
  sendState: "failed" | "unconfirmed",
  sendRunId = "run-background",
  error?: string,
): ApplicationPlacementStartupStatus {
  return {
    sessionKey: "agent:main:dashboard:background",
    targetKind: "device",
    phase: "failed",
    startedAt: 1,
    error,
    initialTurn: {
      id: sendRunId,
      text: "background turn",
      createdAt: 1,
      sendRunId,
      sendState,
      sendError: error,
    },
  };
}

describe("DraftSubmissionFlow background completion", () => {
  it.each([
    "replacement Gateway",
    "changed credentials",
    "changed account",
    "unscoped reconnect",
    "same-owner reconnect",
  ] as const)("binds an already displayed completion action across %s", async (scenario) => {
    const published = createDeferred();
    const showToast = vi.spyOn(toast, "showToast").mockImplementation(() => {
      published.resolve();
      return true;
    });
    const { context, flow, dispose } = nativeBackgroundFixture({
      request: async (method) => (method === "agent.wait" ? { status: "ok", endedAt: 1 } : {}),
    });
    const navigate = vi.fn();
    Object.assign(context, { navigate });
    Object.assign(context.gateway, { connectionRevision: 1 });
    if (scenario === "unscoped reconnect") {
      delete context.gateway.snapshot.hello!.auth!.recoveryScope;
    }
    try {
      await flow.submit(undefined, true);
      await published.promise;
      expect(showToast).toHaveBeenCalledOnce();
      const action = showToast.mock.calls[0]?.[0].onAction;
      expect(action).toBeTypeOf("function");
      context.gateway.snapshot.client = createDraftFixture().context.gateway.snapshot.client;
      if (scenario === "replacement Gateway") {
        Object.assign(context.gateway.connection, { gatewayUrl: "ws://replacement.example" });
        Object.assign(context.gateway, { connectionRevision: 2 });
      } else if (scenario === "changed credentials") {
        Object.assign(context.gateway, { connectionRevision: 2 });
      } else if (scenario === "changed account") {
        context.gateway.snapshot.hello!.auth!.recoveryScope = "principal-b";
      }
      action?.();
      expect(context.gateway.setSessionKey).toHaveBeenCalledTimes(
        scenario === "same-owner reconnect" ? 1 : 0,
      );
      expect(context.agentSelection.set).toHaveBeenCalledTimes(
        scenario === "same-owner reconnect" ? 1 : 0,
      );
      expect(navigate).toHaveBeenCalledTimes(scenario === "same-owner reconnect" ? 1 : 0);
    } finally {
      dispose();
    }
  });
  it.each([
    { status: "idle" as const },
    { status: "started" as const },
    { status: "rejected" as const, error: "The first turn was rejected" },
  ])("never turns an accepted $status background creation into navigation", async (initialRun) => {
    const { context, flow } = createDraftFixture();
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:accepted",
      initialRun,
    });
    flow.setMessage("Create without moving my current session");
    await flow.submit(undefined, true);
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(context.navigateAndWait).not.toHaveBeenCalled();
    expect(context.gateway.setSessionKey).not.toHaveBeenCalled();
    expect(context.agentSelection.set).not.toHaveBeenCalled();
    expect(flow.message).toBe("");
    expect(flow.completedSubmission?.key).toBe("agent:main:dashboard:accepted");
    expect(flow.pendingMessage?.content).toContainEqual({
      type: "text",
      text: "Create without moving my current session",
    });
  });

  it("resumes a background create with its exact request and no navigation", async () => {
    const { context, flow } = createDraftFixture();
    let finishOriginal!: (value: { key: string; initialRun: { status: "idle" } }) => void;
    const result = {
      key: "agent:main:dashboard:resumed-background",
      initialRun: { status: "idle" as const },
    };
    vi.mocked(context.sessions.createResult)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOriginal = resolve;
          }),
      )
      .mockResolvedValueOnce(result);
    flow.setMessage("Keep this task in the background through reconnect");
    const first = flow.submit(undefined, true);
    const original = vi.mocked(context.sessions.createResult).mock.calls[0]?.[0];
    flow.invalidate("gateway-changed");
    flow.resumeInterruptedSubmission();
    await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledTimes(2));
    expect(vi.mocked(context.sessions.createResult).mock.calls[1]?.[0]).toEqual(original);
    finishOriginal(result);
    await first;
    await vi.waitFor(() => expect(flow.submitting).toBe(false));
    expect(context.navigateAndWait).not.toHaveBeenCalled();
    expect(context.gateway.setSessionKey).not.toHaveBeenCalled();
  });

  it("delivers an accepted background completion before the first native status reply", async () => {
    const { context, flow, postMessage, dispose } = nativeBackgroundFixture({
      request: async (method) => (method === "agent.wait" ? { status: "ok", endedAt: 1 } : {}),
    });
    try {
      await flow.submit(undefined, true);
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
      expect(postMessage).toHaveBeenLastCalledWith({
        type: "background-session-completed",
        runId: "run-background",
        path: "/chat/main/dashboard/background",
      });
      expect(context.navigateAndWait).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it.each(["selected session", "replaced Gateway", "changed credentials", "changed account"])(
    "suppresses a background completion for the %s",
    async (scenario) => {
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
      const { context, flow, request, postMessage, dispose } = nativeBackgroundFixture();
      request.mockImplementation(async (method) => {
        if (method === "agent.wait") {
          if (scenario === "selected session") {
            context.gateway.snapshot.sessionKey = "agent:main:dashboard:background";
          } else if (scenario === "changed credentials") {
            Object.assign(context.gateway, { connectionRevision: 2 });
          } else if (scenario === "changed account") {
            context.gateway.snapshot.hello!.auth!.recoveryScope = "principal-b";
          } else {
            context.gateway.snapshot.client = null;
          }
          return { status: "ok", endedAt: 1 };
        }
        return {};
      });
      try {
        await flow.submit(undefined, true);
        await Promise.resolve();
        expect(postMessage.mock.calls).toEqual([[{ type: "status" }]]);
        expect(showToast).not.toHaveBeenCalled();
      } finally {
        dispose();
      }
    },
  );

  it.each([
    { scenario: "an observation deadline", observed: { status: "timeout" }, placement: null },
    {
      scenario: "a retryable provider error",
      observed: { status: "timeout", error: "Retryable provider failure", pendingError: true },
      placement: null,
    },
    { scenario: "a queued turn", observed: { status: "pending" }, placement: null },
    {
      scenario: "checking placement delivery",
      observed: { status: "timeout" },
      placement: failedPlacement("unconfirmed"),
    },
    {
      scenario: "paused unconfirmed placement delivery",
      observed: { status: "timeout" },
      placement: failedPlacement("unconfirmed", "run-background", "Delivery remains unconfirmed"),
    },
    {
      scenario: "a newer placement retry failure",
      observed: { status: "timeout" },
      placement: failedPlacement("failed", "newer-run", "Newer retry rejected"),
    },
    {
      scenario: "a placement display error without a recorded send outcome",
      observed: { status: "timeout" },
      placement: { ...failedPlacement("failed"), initialTurn: undefined },
    },
  ])(
    "waits for terminal background completion after $scenario",
    async ({ observed, placement }) => {
      vi.useFakeTimers();
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
      let finishRun!: (result: { status: "ok"; endedAt: number }) => void;
      const terminal = new Promise<{ status: "ok"; endedAt: number }>((resolve) => {
        finishRun = resolve;
      });
      const observations = [Promise.resolve(observed), terminal];
      const { context, flow, request, postMessage, dispose } = nativeBackgroundFixture({
        request: async (method) => (method === "agent.wait" ? observations.shift() : {}),
      });

      Object.assign(context.placementStartup, { get: () => placement });

      try {
        await flow.submit(undefined, true);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(postMessage.mock.calls).toEqual([[{ type: "status" }]]);
        expect(showToast).not.toHaveBeenCalled();
        expect(request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(2);

        finishRun({ status: "ok", endedAt: 1 });
        await vi.advanceTimersByTimeAsync(0);
        expect(postMessage.mock.calls).toEqual([
          [{ type: "status" }],
          [
            {
              type: "background-session-completed",
              runId: "run-background",
              path: "/chat/main/dashboard/background",
            },
          ],
        ]);
        expect(showToast).toHaveBeenCalledOnce();
      } finally {
        context.gateway.snapshot.client = null;
        finishRun({ status: "ok", endedAt: 1 });
        await vi.advanceTimersByTimeAsync(0);
        dispose();
      }
    },
  );

  it("notifies a confirmed placement failure for the exact background run", async () => {
    const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
    const { context, flow, request, postMessage, dispose } = nativeBackgroundFixture({
      request: async (method) => (method === "agent.wait" ? { status: "timeout" } : {}),
    });
    Object.assign(context.placementStartup, {
      get: () => failedPlacement("failed", "run-background", "Placement rejected"),
    });
    try {
      await flow.submit(undefined, true);
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
      expect(postMessage).toHaveBeenLastCalledWith({
        type: "background-session-completed",
        runId: "run-background",
        path: "/chat/main/dashboard/background",
      });
      expect(showToast).toHaveBeenCalledOnce();
      expect(request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});
