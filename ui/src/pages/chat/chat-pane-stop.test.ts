/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-stop.test/"} */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { createChatPaneSessionActionCallbacks } from "./chat-pane-session-controls.ts";
import { createSessionCapabilityFixture, createTestChatPane } from "./chat-pane.test-support.ts";
import { handleAbortChat, replayPendingChatAbort } from "./run-lifecycle.ts";

function createStopFixture(scopes = ["operator.write"], useSessionOwner = false) {
  const request = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({
    aborted: true,
  }));
  const client = createTestGatewayClient(request);
  const sessions = useSessionOwner
    ? createTestSessionCapability({
        snapshot: { client, phase: "connected", hello: sessionMutationGatewayHello(scopes) },
        subscribe: () => () => undefined,
        subscribeEvents: () => () => undefined,
      })
    : createSessionCapabilityFixture();
  if (useSessionOwner) {
    onTestFinished(() => sessions.dispose());
  }
  const { pane, state } = createTestChatPane({
    client,
    sessions,
  });
  state.chatRunId = "original-run";
  state.chatMessage = "keep this draft";
  state.pendingAbort = null;
  const session: GatewaySessionRow = {
    key: state.sessionKey,
    kind: "direct",
    sessionId: "original-session",
    sharingRole: "owner",
    hasActiveRun: true,
    activeRunIds: ["original-run"],
    status: "running",
    updatedAt: 1,
  };
  state.sessionsResult = { ...createSessionsListResult(), sessions: [session] };
  let snapshot: ApplicationGatewaySnapshot = {
    ...pane.context.gateway.snapshot,
    hello: sessionMutationGatewayHello(scopes),
  };
  state.hello = snapshot.hello;
  const onDenied = vi.fn();
  const callbacks = (sessionParticipationBlocked = false) =>
    createChatPaneSessionActionCallbacks({
      getSnapshot: () => snapshot,
      state,
      sessionParticipationBlocked,
      onDenied,
      onAbort: () => void handleAbortChat(state, { preserveDraft: true }),
      onRewind: vi.fn(async () => true),
      onFork: vi.fn(async () => {}),
    });
  const disconnect = (nextClient: typeof state.client = client) => {
    snapshot = { ...snapshot, client: nextClient, phase: "reconnecting", hello: null };
    pane.applyGatewaySnapshot(snapshot);
  };
  const reconnect = (nextScopes = scopes, methods?: string[], recoveryScope?: string) => {
    const hello = sessionMutationGatewayHello(nextScopes);
    if (hello.auth && recoveryScope !== undefined) {
      hello.auth.recoveryScope = recoveryScope;
    }
    if (methods) {
      hello.features = { ...hello.features, methods };
    }
    snapshot = {
      ...snapshot,
      phase: "connected",
      hello,
    };
    state.connected = true;
    state.hello = snapshot.hello;
  };
  return { pane, state, session, client, request, callbacks, disconnect, reconnect, onDenied };
}

describe("chat pane Stop intent", () => {
  it.each(["operator.write", "operator.sessions.write"])(
    "replays only the captured run once with %s",
    async (scope) => {
      const fixture = createStopFixture([scope]);
      fixture.disconnect();
      const stop = fixture.callbacks().onAbort;
      expect(stop).toBeTypeOf("function");
      stop?.();
      expect(fixture.request).not.toHaveBeenCalled();
      expect(fixture.state.chatMessage).toBe("keep this draft");

      fixture.state.chatRunId = "replacement-run";
      fixture.reconnect();
      expect(await replayPendingChatAbort(fixture.state)).toBe(true);
      expect(await replayPendingChatAbort(fixture.state)).toBe(false);
      expect(fixture.request.mock.calls).toEqual([
        ["chat.abort", { sessionKey: fixture.state.sessionKey, runId: "original-run" }],
      ]);
    },
  );

  it("rechecks a Stop rendered before the transport dropped", () => {
    const fixture = createStopFixture();
    const stop = fixture.callbacks().onAbort;
    fixture.disconnect();
    stop?.();
    expect(fixture.state.pendingAbort?.runId).toBe("original-run");
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it.each([false, true])("retires the old client's run with queued Stop=%s", async (queued) => {
    const fixture = createStopFixture();
    fixture.disconnect();
    const staleStop = fixture.callbacks().onAbort;
    if (queued) {
      staleStop?.();
    }
    const replacementRequest = vi.fn();
    fixture.disconnect(createTestGatewayClient(replacementRequest));
    staleStop?.();
    expect(fixture.state.chatRunId).toBeNull();
    expect(fixture.callbacks().onAbort).toBeUndefined();
    fixture.reconnect();
    expect(await replayPendingChatAbort(fixture.state)).toBe(false);
    expect(fixture.request).not.toHaveBeenCalled();
    expect(replacementRequest).not.toHaveBeenCalled();
    expect(fixture.state.chatMessage).toBe("keep this draft");
  });

  it("keeps participation and exact-run requirements while offline", () => {
    const fixture = createStopFixture();
    fixture.disconnect();
    expect(fixture.callbacks(true).onAbort).toBeUndefined();
    fixture.state.chatRunId = null;
    expect(fixture.callbacks().onAbort).toBeUndefined();
    fixture.state.chatRunId = "original-run";
    fixture.disconnect(null);
    expect(fixture.callbacks().onAbort).toBeUndefined();
  });

  it("consumes revoked intent and permits a fresh authorized Stop after access returns", async () => {
    const fixture = createStopFixture();
    fixture.disconnect();
    fixture.callbacks().onAbort?.();
    expect(fixture.state.pendingAbort?.runId).toBe("original-run");
    fixture.reconnect(["operator.read"]);
    expect(await replayPendingChatAbort(fixture.state)).toBe(false);
    expect(fixture.request).not.toHaveBeenCalled();
    expect(fixture.callbacks().onAbort).toBeUndefined();

    fixture.reconnect();
    expect(await replayPendingChatAbort(fixture.state)).toBe(false);
    fixture.callbacks().onAbort?.();
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledOnce());
  });

  it.each(["operator.sessions.write", "operator.admin"])(
    "retires a previous principal's Stop before the same client's recovery settles with %s",
    async (scope) => {
      const fixture = createStopFixture(["operator.sessions.write"]);
      const renderedStop = fixture.callbacks().onAbort;
      fixture.disconnect();
      renderedStop?.();
      expect(fixture.state.pendingAbort?.runId).toBe("original-run");
      Object.defineProperty(fixture.client, "recoveryScopeReady", { get: () => false });
      fixture.reconnect([scope], undefined, "different-principal");
      expect(await replayPendingChatAbort(fixture.state)).toBe(false);
      expect(fixture.state.pendingAbort).toBeNull();
      renderedStop?.();
      expect(fixture.request).not.toHaveBeenCalled();
      fixture.reconnect(["operator.sessions.write"], undefined, "test-recovery-scope");
      expect(await replayPendingChatAbort(fixture.state)).toBe(false);
    },
  );

  it.each([true, false])(
    "waits for legacy recovery identity before replay (same principal=%s)",
    async (samePrincipal) => {
      const fixture = createStopFixture(["operator.sessions.write"]);
      fixture.disconnect();
      fixture.callbacks().onAbort?.();
      let ready = false;
      Object.defineProperty(fixture.client, "recoveryScopeReady", { get: () => ready });
      fixture.reconnect();
      expect(await replayPendingChatAbort(fixture.state)).toBe(false);
      expect(fixture.state.pendingAbort?.runId).toBe("original-run");
      expect(fixture.request).not.toHaveBeenCalled();
      Object.defineProperty(fixture.client, "recoveryScope", {
        get: () => (samePrincipal ? "test-recovery-scope" : "different-principal"),
      });
      ready = true;
      expect(await replayPendingChatAbort(fixture.state)).toBe(samePrincipal);
      expect(fixture.state.pendingAbort).toBeNull();
      expect(fixture.request).toHaveBeenCalledTimes(samePrincipal ? 1 : 0);
    },
  );

  it("refuses offline Stop when the preceding hello never resolved its identity", async () => {
    const fixture = createStopFixture(["operator.sessions.write"]);
    Object.defineProperty(fixture.client, "recoveryScope", { get: () => "" });
    Object.defineProperty(fixture.client, "recoveryScopeReady", { get: () => false });
    const renderedStop = fixture.callbacks().onAbort;
    fixture.disconnect();
    renderedStop?.();
    await handleAbortChat(fixture.state, { preserveDraft: true });
    expect(fixture.state.pendingAbort).toBeNull();
    expect(fixture.request).not.toHaveBeenCalled();
    fixture.reconnect(["operator.admin"], undefined, "test-recovery-scope");
    expect(await replayPendingChatAbort(fixture.state)).toBe(false);
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("rechecks online write access when a rendered Stop is clicked", () => {
    const fixture = createStopFixture();
    const stop = fixture.callbacks().onAbort;
    fixture.reconnect(["operator.read"]);
    stop?.();
    expect(fixture.request).not.toHaveBeenCalled();
    expect(fixture.onDenied).toHaveBeenCalledOnce();
  });

  it.each(["owner", "member", "viewer"] as const)(
    "limits a narrow Stop to its %s row",
    (sharingRole) => {
      const fixture = createStopFixture(["operator.sessions.write"]);
      fixture.session.sharingRole = sharingRole;
      const stop = fixture.callbacks().onAbort;
      expect(typeof stop).toBe(sharingRole === "owner" ? "function" : "undefined");
      stop?.();
      expect(fixture.request).toHaveBeenCalledTimes(sharingRole === "owner" ? 1 : 0);
    },
  );

  it.each(["ownership", "missing-row", "session", "run", "row-run", "route"] as const)(
    "does not retarget a rendered Stop after changing %s",
    (change) => {
      const fixture = createStopFixture();
      if (change === "row-run") {
        fixture.state.chatRunId = null;
      }
      const stop = fixture.callbacks().onAbort;
      expect(stop).toBeTypeOf("function");
      if (change === "ownership" || change === "missing-row") {
        fixture.reconnect(["operator.sessions.write"]);
        if (change === "ownership") {
          fixture.session.sharingRole = "viewer";
        } else {
          fixture.state.sessionsResult = { ...createSessionsListResult(), sessions: [] };
        }
      } else if (change === "session") {
        fixture.session.sessionId = "replacement-session";
      } else if (change === "run") {
        fixture.state.chatRunId = "replacement-run";
      } else if (change === "row-run") {
        fixture.session.activeRunIds = ["replacement-run"];
      } else {
        fixture.state.sessionKey = "agent:main:other";
      }
      stop?.();
      expect(fixture.request).not.toHaveBeenCalled();
      expect(fixture.state.chatMessage).toBe("keep this draft");
    },
  );

  it.each([true, false])(
    "authorizes the captured row rather than the new selection (owns original=%s)",
    async (ownsOriginal) => {
      const fixture = createStopFixture(["operator.sessions.write"]);
      fixture.disconnect();
      fixture.callbacks().onAbort?.();
      expect(fixture.state.pendingAbort?.runId).toBe("original-run");
      fixture.session.sharingRole = ownsOriginal ? "owner" : "viewer";
      const replacement: GatewaySessionRow = {
        key: "agent:main:other",
        kind: "direct",
        sessionId: "other-session",
        sharingRole: ownsOriginal ? "viewer" : "owner",
      };
      fixture.state.sessionKey = replacement.key;
      fixture.state.chatRunId = "other-run";
      fixture.state.sessionsResult = {
        ...createSessionsListResult(),
        sessions: [replacement, fixture.session],
      };
      fixture.reconnect();
      expect(await replayPendingChatAbort(fixture.state)).toBe(ownsOriginal);
      expect(fixture.state.pendingAbort).toBeNull();
      expect(fixture.request.mock.calls).toEqual(
        ownsOriginal
          ? [["chat.abort", { sessionKey: fixture.session.key, runId: "original-run" }]]
          : [],
      );
    },
  );

  it("replays recovered embedded Stop through its captured advertised method", async () => {
    const fixture = createStopFixture(["operator.sessions.write"]);
    fixture.state.chatRunSessionAbortable = true;
    fixture.disconnect();
    fixture.callbacks().onAbort?.();
    fixture.state.chatRunId = "replacement-browser-run";
    fixture.state.chatRunSessionAbortable = false;
    fixture.reconnect(["operator.sessions.write"], ["sessions.abort"]);
    expect(await replayPendingChatAbort(fixture.state)).toBe(true);
    expect(fixture.request.mock.calls).toEqual([
      ["sessions.abort", { key: fixture.session.key, runId: "original-run" }],
    ]);
  });

  it.each(["owner", "viewer"] as const)(
    "settles waiting narrow Stop when the canonical row arrives as %s",
    async (sharingRole) => {
      const fixture = createStopFixture(["operator.sessions.write"], true);
      fixture.disconnect();
      fixture.callbacks().onAbort?.();
      fixture.state.sessionsResult = { ...createSessionsListResult(), sessions: [] };
      fixture.reconnect();
      expect(await replayPendingChatAbort(fixture.state)).toBe(false);
      expect(fixture.state.pendingAbort?.runId).toBe("original-run");
      expect(fixture.request).not.toHaveBeenCalled();
      fixture.pane.presented = false;
      fixture.session.sharingRole = sharingRole;
      const unsubscribe = fixture.state.sessions.subscribe((state) =>
        fixture.pane.applySessionsState(state),
      );
      onTestFinished(unsubscribe);
      fixture.request.mockImplementation(async (method) =>
        method === "sessions.list"
          ? { ...createSessionsListResult(), sessions: [fixture.session] }
          : { aborted: true },
      );
      await fixture.state.sessions.refresh({ agentId: "main", force: true });
      fixture.pane.applySessionsState(fixture.state.sessions.state);
      expect(await replayPendingChatAbort(fixture.state)).toBe(false);
      expect(fixture.state.pendingAbort).toBeNull();
      expect(fixture.request.mock.calls.filter(([method]) => method === "chat.abort")).toEqual(
        sharingRole === "owner"
          ? [["chat.abort", { sessionKey: fixture.session.key, runId: "original-run" }]]
          : [],
      );
    },
  );

  it("retires captured Stop when its session incarnation is replaced", async () => {
    const fixture = createStopFixture(["operator.sessions.write"]);
    fixture.disconnect();
    fixture.callbacks().onAbort?.();
    fixture.session.sessionId = "replacement-session";
    fixture.reconnect();
    expect(await replayPendingChatAbort(fixture.state)).toBe(false);
    expect(fixture.state.pendingAbort).toBeNull();
    expect(fixture.request).not.toHaveBeenCalled();
  });
});
