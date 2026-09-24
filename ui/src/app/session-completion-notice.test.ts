/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import * as toast from "../lib/toast.ts";
import type { ApplicationContext } from "./context.ts";
import {
  showSessionCompletionNotice,
  type SessionCompletionNotice,
} from "./session-completion-notice.ts";

const notice: SessionCompletionNotice = {
  sessionKey: "agent:worker:dashboard:task",
  agentId: "worker",
  runId: "run-1",
  status: "ok",
};
function fixture(enabled = true) {
  const client = {} as GatewayBrowserClient;
  const context = {
    basePath: "",
    gateway: {
      connection: { gatewayUrl: "ws://gateway.example" },
      snapshot: { client, phase: "connected", selfUser: { id: "owner" }, hello: null },
      setSessionKey: vi.fn(),
    },
    inAppNotifications: { snapshot: { enabled } },
    sessions: {
      state: {
        result: {
          sessions: [{ key: notice.sessionKey, agentId: "worker", displayName: "Background task" }],
        },
      },
    },
    agents: { state: { agentsList: null } },
    agentSelection: { state: { selectedId: "main" }, set: vi.fn() },
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  const show = vi.spyOn(toast, "showToast").mockImplementation(() => true);
  return {
    context,
    client,
    show,
    emit: (payload: unknown = notice, backgroundStart = false) =>
      showSessionCompletionNotice({ context, client, payload, backgroundStart }),
  };
}
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
describe("session completion notice admission", () => {
  it("is opt-in, but preserves explicit background-start notices", () => {
    const f = fixture(false);
    f.emit();
    expect(f.show).not.toHaveBeenCalled();
    f.emit(notice, true);
    expect(f.show).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "deduplicates general and background events regardless of order (%s)",
    (backgroundFirst) => {
      const f = fixture();
      f.emit(notice, backgroundFirst);
      f.emit(notice, !backgroundFirst);
      f.emit();
      expect(f.show).toHaveBeenCalledOnce();
      f.emit({ ...notice, runId: "run-2" });
      expect(f.show).toHaveBeenCalledTimes(2);
    },
  );
  it("labels the session, queues outcomes, and opens its exact agent/session", () => {
    const f = fixture();
    f.emit();
    const options = f.show.mock.calls[0]![0];
    expect(options).toMatchObject({
      fifo: true,
      message: "Background task: Done",
      actionLabel: "Open session",
    });
    options.onAction?.();
    expect(f.context.gateway.setSessionKey).toHaveBeenCalledWith(notice.sessionKey);
    expect(f.context.agentSelection.set).toHaveBeenCalledWith("worker");
    expect(f.context.navigate).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: expect.stringContaining("worker") }),
    );
  });
  it.each(["ok", "error", "timeout", "aborted"] as const)(
    "distinguishes terminal outcome %s",
    (status) => {
      const f = fixture();
      f.emit({ ...notice, status });
      expect(f.show).toHaveBeenCalledOnce();
      expect(f.show.mock.calls[0]![0].message).toContain(
        { ok: "Done", error: "Failed", timeout: "Timed out", aborted: "Killed" }[status],
      );
    },
  );
  it("suppresses any visible pane, not just the selected pane, and does not replay it later", () => {
    const f = fixture();
    const pane = document.createElement("openclaw-chat-pane");
    Object.assign(pane, {
      conversationPresented: true,
      sessionKey: notice.sessionKey,
      agentId: "worker",
    });
    document.body.append(pane);
    f.emit();
    expect(f.show).not.toHaveBeenCalled();
    pane.remove();
    f.emit();
    expect(f.show).not.toHaveBeenCalled();
  });
  it("ignores retained hidden panes and distinguishes global sessions by agent", () => {
    const f = fixture();
    const pane = document.createElement("openclaw-chat-pane");
    Object.assign(pane, {
      conversationPresented: false,
      sessionKey: notice.sessionKey,
      agentId: "worker",
    });
    document.body.append(pane);
    f.emit();
    expect(f.show).toHaveBeenCalledOnce();
    Object.assign(pane, { conversationPresented: true, sessionKey: "global", agentId: "main" });
    f.emit({ ...notice, sessionKey: "global", runId: "run-2" });
    expect(f.show).toHaveBeenCalledTimes(2);
  });
  it("rejects malformed events, retired clients, and disconnected delivery", () => {
    const f = fixture();
    f.emit({ ...notice, status: "pending" });
    f.emit({ ...notice, agentId: "" });
    f.emit(null);
    expect(f.show).not.toHaveBeenCalled();
    Object.assign(f.context.gateway.snapshot, { phase: "reconnecting" });
    f.emit();
    expect(f.show).not.toHaveBeenCalled();
    Object.assign(f.context.gateway.snapshot, { phase: "connected", client: {} });
    f.emit();
    expect(f.show).not.toHaveBeenCalled();
  });
  it("fences delayed click actions after profile replacement", () => {
    const f = fixture();
    f.emit();
    Object.assign(f.context.gateway.snapshot, { selfUser: { id: "different" } });
    f.show.mock.calls[0]![0].onAction?.();
    expect(f.context.navigate).not.toHaveBeenCalled();
  });
});

it.each(["profile", "reconnect", "replacement", "visible pane", "opt out"])(
  "discards queued completion after %s and continues the FIFO",
  async (change) => {
    const f = fixture();
    f.show.mockRestore();
    const host = document.createElement("openclaw-toast-host");
    document.body.append(host);
    await host.updateComplete;
    toast.showToast({ message: "Existing notice" });
    f.emit();
    toast.showToast({ message: "Still relevant", fifo: true });
    if (change === "profile") {
      Object.assign(f.context.gateway.snapshot, { selfUser: { id: "other" } });
    } else if (change === "reconnect") {
      Object.assign(f.context.gateway, { connectionRevision: 2 });
    } else if (change === "replacement") {
      Object.assign(f.context.gateway.snapshot, { client: {} });
    } else if (change === "opt out") {
      Object.assign(f.context.inAppNotifications.snapshot, { enabled: false });
    } else {
      const pane = document.createElement("openclaw-chat-pane");
      Object.assign(pane, {
        conversationPresented: true,
        agentId: notice.agentId,
        sessionKey: notice.sessionKey,
      });
      document.body.append(pane);
    }
    await host.updateComplete;
    host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
    await host.updateComplete;
    expect(host.textContent).toContain("Still relevant");
    expect(host.textContent).not.toContain("Background task");
  },
);

it("preserves explicit-background entitlement when a general completion queued first", async () => {
  const f = fixture();
  f.show.mockRestore();
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await host.updateComplete;
  toast.showToast({ message: "Existing notice" });
  f.emit();
  f.emit(notice, true);
  Object.assign(f.context.inAppNotifications.snapshot, { enabled: false });
  await host.updateComplete;
  host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
  await host.updateComplete;
  expect(host.textContent).toContain("Background task: Done");
  host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
  await host.updateComplete;
  expect(host.querySelector(".app-toast")).toBeNull();
});

it("restores late background entitlement after opt-out discarded the queued general notice", async () => {
  const f = fixture();
  f.show.mockRestore();
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await host.updateComplete;
  toast.showToast({ message: "Existing notice" });
  f.emit();
  Object.assign(f.context.inAppNotifications.snapshot, { enabled: false });
  await host.updateComplete;
  host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
  await host.updateComplete;
  expect(host.querySelector(".app-toast")).toBeNull();
  f.emit(notice, true);
  await host.updateComplete;
  expect(host.textContent).toContain("Background task: Done");
  host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
  await host.updateComplete;
  f.emit(notice, true);
  await host.updateComplete;
  expect(host.querySelector(".app-toast")).toBeNull();
});
it("does not restore a queued notice that was suppressed because its session became visible", async () => {
  const f = fixture();
  f.show.mockRestore();
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await host.updateComplete;
  toast.showToast({ message: "Existing notice" });
  f.emit();
  const pane = document.createElement("openclaw-chat-pane");
  Object.assign(pane, {
    conversationPresented: true,
    agentId: notice.agentId,
    sessionKey: notice.sessionKey,
  });
  document.body.append(pane);
  await host.updateComplete;
  host.querySelector<HTMLButtonElement>(".app-toast__dismiss")!.click();
  await host.updateComplete;
  expect(host.querySelector(".app-toast")).toBeNull();
  pane.remove();
  f.emit(notice, true);
  await host.updateComplete;
  expect(host.querySelector(".app-toast")).toBeNull();
});
