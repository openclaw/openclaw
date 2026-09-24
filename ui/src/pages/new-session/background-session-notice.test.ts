/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { ShellGatewayOwner, type ShellGatewayHost } from "../../app/app-shell-gateway.ts";
import { handleSessionCompletionEvent } from "../../app/background-session-tracker.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "../../app/gateway-store.test-support.ts";
import { showSessionCompletionNotice } from "../../app/session-completion-notice.ts";
import * as toast from "../../lib/toast.ts";
import { prepareBackgroundSessionCompletion } from "./background-session-notice.ts";

vi.mock("../../app/bootstrap-warm-boot.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/bootstrap-warm-boot.ts")>()),
  // Credential replacement also clears unrelated persistent warm-boot caches.
  clearWarmBootState: vi.fn(),
}));

const key = "agent:main:dashboard:test";
function fixture(result: Record<string, unknown> | Promise<Record<string, unknown>>) {
  const client = { request: vi.fn(async () => result) };
  const backgroundSessionCompleted = vi.fn();
  const context = {
    gateway: {
      connection: { gatewayUrl: "ws://gateway.example" },
      snapshot: { client, phase: "connected", selfUser: { id: "owner" }, hello: null },
    },
    inAppNotifications: { snapshot: { enabled: true } },
    sessions: { state: { result: { sessions: [] } } },
    nativeNotifications: { backgroundSessionCompleted },
  } as unknown as ApplicationContext;
  const show = vi.spyOn(toast, "showToast").mockImplementation(() => true);
  return {
    context,
    backgroundSessionCompleted,
    owner: new ShellGatewayOwner({ context } as ShellGatewayHost),
    client: context.gateway.snapshot.client!,
    show,
    start: () =>
      prepareBackgroundSessionCompletion({
        context,
        client: context.gateway.snapshot.client!,
        agentId: "main",
        enabled: true,
      })(key, "run-1"),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
it("keeps explicit background completion through child yields with general notices off", async () => {
  const f = fixture({ status: "ok", endedAt: 1, yielded: true });
  Object.assign(f.context.inAppNotifications.snapshot, { enabled: false });
  f.start();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.show).not.toHaveBeenCalled();
  f.owner.handleGatewayEvent({
    type: "event",
    event: "session.run.completed",
    payload: {
      sessionKey: key,
      agentId: "main",
      runId: "continuation",
      status: "ok",
    },
  });
  await vi.waitFor(() => expect(f.show).toHaveBeenCalledOnce());
  expect(f.backgroundSessionCompleted).toHaveBeenCalledOnce();
  expect(f.backgroundSessionCompleted).toHaveBeenCalledWith(
    expect.objectContaining({ runId: "continuation" }),
  );
  handleSessionCompletionEvent({
    context: f.context,
    client: f.client,
    payload: {
      sessionKey: key,
      agentId: "main",
      runId: "later-unrelated-turn",
      status: "ok",
    },
  });
  expect(f.show).toHaveBeenCalledOnce();
  expect(f.backgroundSessionCompleted).toHaveBeenCalledOnce();
});
it.each([true, false])(
  "handles continuation settlement before agent.wait returns (yielded=%s)",
  async (yielded) => {
    let finishWait!: (value: Record<string, unknown>) => void;
    const f = fixture(
      new Promise((resolve) => {
        finishWait = resolve;
      }),
    );
    Object.assign(f.context.inAppNotifications.snapshot, { enabled: false });
    f.start();
    handleSessionCompletionEvent({
      context: f.context,
      client: f.client,
      payload: {
        sessionKey: key,
        agentId: "main",
        runId: "continuation",
        status: "ok",
      },
    });
    expect(f.show).not.toHaveBeenCalled();
    finishWait({ status: "ok", endedAt: 1, yielded });
    await vi.waitFor(() => expect(f.show).toHaveBeenCalledOnce());
    expect(f.backgroundSessionCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: yielded ? "continuation" : "run-1",
      }),
    );
  },
);
it.each(["profile", "connection"])(
  "retires background continuation intent after a %s change",
  async (change) => {
    const f = fixture({ status: "ok", endedAt: 1, yielded: true });
    Object.assign(f.context.inAppNotifications.snapshot, { enabled: false });
    f.start();
    await Promise.resolve();
    await Promise.resolve();
    if (change === "profile") {
      Object.assign(f.context.gateway.snapshot, { selfUser: { id: "other" } });
    } else {
      Object.assign(f.context.gateway, { connectionRevision: 1 });
    }
    handleSessionCompletionEvent({
      context: f.context,
      client: f.client,
      payload: {
        sessionKey: key,
        agentId: "main",
        runId: "continuation",
        status: "ok",
      },
    });
    expect(f.show).not.toHaveBeenCalled();
    expect(f.backgroundSessionCompleted).not.toHaveBeenCalled();
  },
);
it("does not call a yielded initial run complete", async () => {
  const f = fixture({ status: "ok", endedAt: 1, yielded: true });
  f.start();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.show).not.toHaveBeenCalled();
  expect(f.backgroundSessionCompleted).not.toHaveBeenCalled();
});
it("deduplicates settled background waits with general lifecycle notifications", async () => {
  const f = fixture({ status: "ok", endedAt: 1 });
  f.start();
  await vi.waitFor(() => expect(f.show).toHaveBeenCalledOnce());
  showSessionCompletionNotice({
    context: f.context,
    client: f.client,
    payload: { sessionKey: key, agentId: "main", runId: "run-1", status: "ok" },
  });
  expect(f.show).toHaveBeenCalledOnce();
  expect(f.backgroundSessionCompleted).toHaveBeenCalledOnce();
});
it("suppresses a background completion visible in a secondary pane", async () => {
  const f = fixture({ status: "ok", endedAt: 1 });
  const pane = document.createElement("openclaw-chat-pane");
  Object.assign(pane, { conversationPresented: true, agentId: "main", sessionKey: key });
  document.body.append(pane);
  f.start();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.show).not.toHaveBeenCalled();
  expect(f.backgroundSessionCompleted).not.toHaveBeenCalled();
});
it("ignores a late wait response after the profile changes", async () => {
  const f = fixture({ status: "ok", endedAt: 1 });
  f.start();
  Object.assign(f.context.gateway.snapshot, { selfUser: { id: "other" } });
  await Promise.resolve();
  await Promise.resolve();
  expect(f.show).not.toHaveBeenCalled();
  expect(f.backgroundSessionCompleted).not.toHaveBeenCalled();
});

it.each([false, true])(
  "does not replay an early visible continuation after navigating away (enabled=%s)",
  async (enabled) => {
    let finishWait!: (value: Record<string, unknown>) => void;
    const f = fixture(
      new Promise((resolve) => {
        finishWait = resolve;
      }),
    );
    Object.assign(f.context.inAppNotifications.snapshot, { enabled });
    f.start();
    const pane = document.createElement("openclaw-chat-pane");
    Object.assign(pane, { conversationPresented: true, agentId: "main", sessionKey: key });
    document.body.append(pane);
    handleSessionCompletionEvent({
      context: f.context,
      client: f.client,
      payload: { sessionKey: key, agentId: "main", runId: "continuation", status: "ok" },
    });
    pane.remove();
    finishWait({ status: "ok", endedAt: 1, yielded: true });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.show).not.toHaveBeenCalled();
    expect(f.backgroundSessionCompleted).not.toHaveBeenCalled();
  },
);
it("captures visible panes synchronously when the shell receives a completion", async () => {
  const f = fixture({ status: "ok" });
  const pane = document.createElement("openclaw-chat-pane");
  Object.assign(pane, { conversationPresented: true, agentId: "main", sessionKey: key });
  document.body.append(pane);
  f.owner.handleGatewayEvent({
    type: "event",
    event: "session.run.completed",
    payload: { sessionKey: key, agentId: "main", runId: "visible-completion", status: "ok" },
  });
  pane.remove();
  // Drain deferred dispatch too: navigating away cannot change event-time visibility.
  await new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
  expect(f.show).not.toHaveBeenCalled();
});

// Exercise the production store callbacks: a retry keeps the client/revision,
// clears identity during disconnection, and installs a fresh hello afterward.
it.each(["same-account", "other-account", "replaced-client", "changed-credentials"])(
  "retains explicit background launch intent only for same-account reconnect (%s)",
  async (recovery) => {
    vi.useFakeTimers();
    const f = fixture({ status: "ok", endedAt: 1 });
    const { gateway, current } = createGatewayStoreTestStore();
    Object.assign(f.context, { gateway });
    Object.assign(f.context.inAppNotifications.snapshot, { enabled: false });
    gateway.start();
    const client = current();
    const helloFor = (id: string) => ({
      ...GATEWAY_STORE_TEST_HELLO,
      snapshot: { presence: [{ instanceId: client.instanceId, user: { id, name: id } }] },
    });
    client.opts.onHello?.(helloFor("owner"));
    const initialHello = gateway.snapshot.hello;
    const initialRevision = gateway.connectionRevision;
    let disconnect!: (reason: Error) => void;
    client.request.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          disconnect = reject;
        }),
    );
    client.request.mockResolvedValue({ status: "ok", endedAt: 1 });
    try {
      f.start();
      client.opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
      expect(gateway.snapshot).toMatchObject({
        phase: "reconnecting",
        hello: null,
        selfUser: null,
        client,
      });
      expect(gateway.connectionRevision).toBe(initialRevision);
      disconnect(new Error("socket lost"));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.show).not.toHaveBeenCalled();
      expect(f.backgroundSessionCompleted).not.toHaveBeenCalled();
      if (recovery === "replaced-client") {
        gateway.connect();
      } else if (recovery === "changed-credentials") {
        gateway.connect({ token: "synthetic-replacement-token" });
      }
      current().opts.onHello?.(helloFor(recovery === "other-account" ? "other" : "owner"));
      expect(gateway.snapshot.hello).not.toBe(initialHello);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.show).toHaveBeenCalledTimes(recovery === "same-account" ? 1 : 0);
      expect(f.backgroundSessionCompleted).toHaveBeenCalledTimes(
        recovery === "same-account" ? 1 : 0,
      );
      if (recovery === "same-account") {
        expect(client.request).toHaveBeenCalledTimes(2);
        expect(f.backgroundSessionCompleted).toHaveBeenCalledWith(
          expect.objectContaining({ runId: "run-1" }),
        );
      }
    } finally {
      gateway.stop();
    }
  },
);
