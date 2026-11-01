import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createNativeNotificationsCapability } from "../../app/native-notifications.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import * as toast from "../../lib/toast.ts";
import { createDraftFixture, resetSubmissionMocks } from "./draft-submission-flow.test-support.ts";

afterEach(resetSubmissionMocks);

function nativeBackgroundFixture(options: Parameters<typeof createDraftFixture>[0] = {}) {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawNotifications: { postMessage } } });
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

function placementStatus(
  sendState: "failed" | "waiting-reconnect",
  sendRunId = "run-background",
  error?: string,
): ApplicationPlacementStartupStatus {
  return {
    sessionKey: "agent:main:dashboard:background",
    targetKind: "device",
    phase: sendState === "failed" ? "failed" : "reconnecting",
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

it("uses the chosen identity at completion rather than stale roster artwork", async () => {
  const published = createDeferred();
  const showToast = vi.spyOn(toast, "showToast").mockImplementation(() => {
    published.resolve();
    return true;
  });
  const { context, flow, dispose } = nativeBackgroundFixture({
    agents: [{ id: "main", name: "Old name", identity: { avatar: "data:image/png;base64,b2xk" } }],
    request: async (method) => (method === "agent.wait" ? { status: "ok", endedAt: 1 } : {}),
  });
  vi.spyOn(context.agentIdentity, "get").mockReturnValue({
    agentId: "main",
    name: "Garden keeper",
    nameSource: "config",
    avatar: "data:image/webp;base64,bmV3",
    emoji: "🌱",
  });
  try {
    await flow.submit(undefined, true);
    await published.promise;
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        avatar: {
          id: "main",
          name: "Garden keeper",
          avatar: "data:image/webp;base64,bmV3",
          textAvatar: "🌱",
        },
      }),
    );
  } finally {
    dispose();
  }
});

it.each([
  [true, "replacement Gateway"],
  [true, "changed credentials"],
  [true, "changed account"],
  [true, "unscoped reconnect"],
  [true, "same-owner reconnect"],
  [false, "selected session"],
  [false, "replacement Gateway"],
  [false, "changed credentials"],
  [false, "changed account"],
] as const)("rechecks background authority (displayed: %s, %s)", async (displayed, scenario) => {
  const published = createDeferred();
  const showToast = vi.spyOn(toast, "showToast").mockImplementation(() => {
    published.resolve();
    return true;
  });
  const { context, flow, request, postMessage, dispose } = nativeBackgroundFixture(
    displayed
      ? { request: async (method) => (method === "agent.wait" ? { status: "ok", endedAt: 1 } : {}) }
      : undefined,
  );
  const changeAuthority = () => {
    if (displayed) {
      context.gateway.snapshot.client = createDraftFixture().context.gateway.snapshot.client;
    }
    if (scenario === "replacement Gateway") {
      if (displayed) {
        Object.assign(context.gateway.connection, { gatewayUrl: "ws://replacement.example" });
      } else {
        context.gateway.snapshot.client = null;
      }
    }
    if (scenario === "changed credentials" || (displayed && scenario === "replacement Gateway")) {
      Object.assign(context.gateway, { connectionRevision: 2 });
    } else if (scenario === "changed account") {
      context.gateway.snapshot.hello!.auth!.recoveryScope = "principal-b";
    } else if (scenario === "selected session") {
      context.gateway.snapshot.sessionKey = "agent:main:dashboard:background";
    }
  };
  request.mockImplementation(async (method) => {
    if (method !== "agent.wait") {
      return {};
    }
    if (!displayed) {
      changeAuthority();
    }
    return { status: "ok", endedAt: 1 };
  });
  const navigate = vi.fn();
  if (displayed) {
    Object.assign(context, { navigate });
    Object.assign(context.gateway, { connectionRevision: 1 });
  }
  if (scenario === "unscoped reconnect") {
    delete context.gateway.snapshot.hello!.auth!.recoveryScope;
  }
  try {
    await flow.submit(undefined, true);
    if (!displayed) {
      await Promise.resolve();
      expect(postMessage.mock.calls).toEqual([[{ type: "status" }]]);
      expect(showToast).not.toHaveBeenCalled();
      return;
    }
    await published.promise;
    expect(showToast).toHaveBeenCalledOnce();
    const action = showToast.mock.calls[0]?.[0].onAction;
    expect(action).toBeTypeOf("function");
    changeAuthority();
    for (const event of [
      new MouseEvent("auxclick", { button: 1, cancelable: true }),
      new MouseEvent("click", { metaKey: true, cancelable: true }),
      new MouseEvent("contextmenu", { cancelable: true }),
    ]) {
      action?.(event);
      expect(event.defaultPrevented).toBe(scenario !== "same-owner reconnect");
      expect(navigate).not.toHaveBeenCalled();
    }
    action?.(new MouseEvent("click", { cancelable: true }));
    for (const effect of [context.gateway.setSessionKey, context.agentSelection.set, navigate]) {
      expect(effect).toHaveBeenCalledTimes(scenario === "same-owner reconnect" ? 1 : 0);
    }
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

it.each([
  ["observation deadline", null],
  ["retryable provider error", null, { error: "Retryable provider failure", pendingError: true }],
  ["queued turn", null, { status: "pending" }],
  ["pending delivery", placementStatus("waiting-reconnect")],
  ["newer retry failure", placementStatus("failed", "newer-run", "Newer retry rejected")],
  ["display error without send outcome", { ...placementStatus("failed"), initialTurn: undefined }],
  ["confirmed send failure", placementStatus("failed", "run-background", "Placement rejected")],
] as const)(
  "waits for terminal background completion after %s",
  async (
    scenario,
    placement,
    observed?: { error?: string; pendingError?: boolean; status?: string },
  ) => {
    const alreadyTerminal = scenario === "confirmed send failure";
    vi.useFakeTimers();
    const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
    const terminal = createDeferred<{ status: "ok"; endedAt: number }>();
    const observations = [Promise.resolve({ status: "timeout", ...observed }), terminal.promise];
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
