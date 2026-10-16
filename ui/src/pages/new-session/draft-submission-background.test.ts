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
      scenario: "a newer placement retry failure",
      observed: { status: "timeout" },
      placement: failedPlacement("failed", "newer-run", "Newer retry rejected"),
    },
    {
      scenario: "a placement display error without a recorded send outcome",
      observed: { status: "timeout" },
      placement: { ...failedPlacement("failed"), initialTurn: undefined },
    },
    {
      scenario: "a confirmed placement failure for this run",
      observed: { status: "timeout" },
      placement: failedPlacement("failed", "run-background", "Placement rejected"),
      terminal: true,
    },
  ])(
    "waits for terminal background completion after $scenario",
    async ({ observed, placement, terminal: alreadyTerminal = false }) => {
      vi.useFakeTimers();
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
      const terminal = createDeferred<{ status: "ok"; endedAt: number }>();
      const observations = [Promise.resolve(observed), terminal.promise];
      const { context, flow, request, postMessage, dispose } = nativeBackgroundFixture({
        request: async (method) => (method === "agent.wait" ? observations.shift() : {}),
      });

      Object.assign(context.placementStartup, { get: () => placement });

      try {
        await flow.submit(undefined, true);
        if (!alreadyTerminal) {
          await vi.advanceTimersByTimeAsync(1_000);
          expect(postMessage.mock.calls).toEqual([[{ type: "status" }]]);
          expect(showToast).not.toHaveBeenCalled();
          expect(request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(2);
          terminal.resolve({ status: "ok", endedAt: 1 });
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(
          alreadyTerminal ? 1 : 2,
        );
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
        expect(context.navigateAndWait).not.toHaveBeenCalled();
      } finally {
        context.gateway.snapshot.client = null;
        terminal.resolve({ status: "ok", endedAt: 1 });
        await vi.advanceTimersByTimeAsync(0);
        dispose();
      }
    },
  );
});
