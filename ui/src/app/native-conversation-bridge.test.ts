/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { isSessionRunStateActive } from "../lib/session-run-state.ts";
import { showToast } from "../lib/toast.ts";
import { makeBootRoster } from "./bootstrap.test-support.ts";
import type { ApplicationContext } from "./context.ts";
import { createNativeConversationBridge } from "./native-conversation-bridge.ts";

vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));

const cleanups: Array<() => void> = [];
const nextSession = "agent:main:next";
const target = (sessionKey: string) => ({ agentId: "main", sessionKey });
const result = (ok: boolean, requestId = "request-1", error?: string) => ({
  type: "command-result",
  requestId,
  ok,
  ...(error ? { error } : {}),
});
const success = { ok: true };
const location = (pathname: string, search = "") => ({ pathname, search, hash: "" });
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function fixture(features: string[] = []) {
  const messages: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const changed = () => listeners.forEach((listener) => listener());
  const data = { kind: "session", agentId: "main", sessionKey: "agent:main:main" };
  const match = { routeId: "chat", status: "success", data };
  const snapshot = {
    phase: "connected",
    assistantAgentId: "main",
    hello: null,
    lastErrorAuthReason: null as string | null,
  };
  const row = { key: data.sessionKey, label: "Native conversation", hasActiveRun: false };
  const navigateAndWait = vi.fn(async () => {});
  const elements: HTMLElement[] = [];
  const mountPane = () => {
    const page = document.createElement("openclaw-chat-page");
    const pane = document.createElement("openclaw-chat-pane");
    pane.active = true;
    page.append(pane);
    document.body.append(page);
    elements.push(page, pane);
    return pane;
  };
  const context = {
    basePath: "",
    routeOutlet: {
      renderedElement: (tag: string) =>
        elements.find((element) => element.localName === tag && element.isConnected),
      renderedElements: (tag: string) =>
        elements.filter((element) => element.localName === tag && element.isConnected),
    },
    gateway: { snapshot, subscribe },
    router: {
      getState: () => ({ matches: [match], pendingMatches: [] }),
      subscribe,
    },
    sessions: {
      presentation: { result: { sessions: [row] } },
      state: { result: { sessions: [row] } },
      subscribe,
      isRunVisuallyActive: isSessionRunStateActive,
    },
    agents: { state: { agentsList: null } },
    agentSelection: { state: { selectedId: "main" } },
    navigateAndWait,
  } as unknown as ApplicationContext;
  vi.stubGlobal("__OPENCLAW_NATIVE_EMBED__", {
    platform: "macos",
    formFactor: "desktop",
    surface: "conversation",
  });
  vi.stubGlobal("__OPENCLAW_NATIVE_CONVERSATION__", { contract: 1, features });
  const reply = vi.fn((_message: Record<string, unknown>): Promise<unknown> =>
    Promise.resolve(success),
  );
  const handler = {
    postMessage(message: Record<string, unknown>) {
      expect(this).toBe(handler);
      messages.push(message);
      return reply(message);
    },
  };
  vi.stubGlobal("webkit", { messageHandlers: { openclawConversation: handler } });
  const bridge = createNativeConversationBridge(context)!;
  cleanups.push(() => bridge.dispose());
  const documentId = (
    window as Window &
      typeof globalThis & { __OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__: { documentId: string } }
  )["__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__"].documentId;
  const command = (type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
    window.dispatchEvent(
      new CustomEvent("openclaw:native-conversation-command", {
        detail: { contract: 1, documentId, requestId: "request-1", type, payload, ...extra },
      }),
    );
  const send = async (type: string, payload: unknown, extra: Record<string, unknown> = {}) => {
    command(type, payload, extra);
    await flush();
  };
  return {
    messages,
    elements,
    mountPane,
    messagesOf: (type: string) => messages.filter((message) => message.type === type),
    expectMessage: (message: Record<string, unknown>) =>
      expect(messages).toContainEqual(expect.objectContaining(message)),
    reply,
    bridge,
    documentId,
    binding: { contract: 1, documentId },
    command,
    send,
    go: (sessionKey = nextSession, requestId = "request-1") =>
      send("navigate", target(sessionKey), { requestId }),
    navigate: (sessionKey = nextSession, requestId = "request-1") =>
      command("navigate", target(sessionKey), { requestId }),
    followNavigation() {
      navigateAndWait.mockImplementation(async () => {
        data.sessionKey = nextSession;
        changed();
      });
    },
    select(sessionKey: string) {
      data.sessionKey = sessionKey;
      changed();
    },
    expectLast: (shape: Record<string, unknown>) => expect(messages.at(-1)).toMatchObject(shape),
    expectResults: (...results: Record<string, unknown>[]) =>
      expect(messages.filter((message) => message.type === "command-result")).toMatchObject(
        results,
      ),
    data,
    snapshot,
    row,
    changed,
    navigateAndWait,
    context,
    match,
  };
}

async function flush() {
  // Drain the serialized command and postMessage microtasks, without timer polling.
  for (let i = 0; i < 24; i++) {
    await Promise.resolve();
  }
}

describe("native conversation contract", () => {
  it("publishes bounded change-only sidebar facts only to an opted-in current document", async () => {
    const old = fixture();
    old.bridge.publishSessionFacts([]);
    await flush();
    expect(old.messagesOf("session-facts")).toEqual([]);
    old.bridge.dispose();
    const f = fixture(["session-facts-v1", "unknown-feature"]);
    const row = {
      agentId: "work",
      sessionKey: "agent:work:other",
      hasComposerDraft: true,
      outboxAttentionCount: 61,
    };
    f.bridge.publishSessionFacts([row]);
    f.bridge.publishSessionFacts([{ ...row }]);
    await flush();
    expect(f.messages[0]).toMatchObject({
      capabilities: ["navigate", "presentation", "focus-composer", "session-facts-v1"],
    });
    expect(f.messagesOf("session-facts")).toEqual([
      { ...f.binding, type: "session-facts", revision: 1, sessions: [row] },
    ]);
    f.bridge.publishSessionFacts([]);
    await flush();
    f.expectLast({ revision: 2, sessions: [] });
    for (const invalid of [
      [{ ...row, outboxAttentionCount: -1 }],
      [{ ...row, outboxAttentionCount: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...row, sessionKey: "🦞".repeat(1025) }],
      Array.from({ length: 65 }, (_, index) => ({ ...row, sessionKey: String(index) })),
      Array.from({ length: 64 }, (_, index) => ({
        ...row,
        sessionKey: `${index}${"x".repeat(1024)}`,
      })),
    ]) {
      f.bridge.publishSessionFacts(invalid);
      await flush();
      f.expectLast({ type: "session-facts", sessions: null });
    }
    f.bridge.dispose();
    const count = f.messages.length;
    f.bridge.publishSessionFacts([row]);
    await flush();
    expect(f.messages).toHaveLength(count);
  });

  it("rejects unadvertised or hidden session action commands before navigation", async () => {
    const old = fixture();
    await old.send("open-session-actions", old.data);
    expect(old.navigateAndWait).not.toHaveBeenCalled();
    old.expectResults({ error: "unsupported" });
    old.bridge.dispose();
    const f = fixture(["session-actions-v1"]);
    await f.send("presentation", { visible: false, active: false });
    await f.send("open-session-actions", target(f.data.sessionKey), { requestId: "hidden" });
    expect(f.navigateAndWait).not.toHaveBeenCalled();
    f.expectResults(result(true), result(false, "hidden", "unavailable"));
  });

  it.each(["current", "superseded", "detached", "retired"] as const)(
    "waits for rendered session actions without opening a stale menu (%s)",
    async (owner) => {
      const f = fixture(["session-actions-v1"]);
      const pane = f.mountPane();
      pane.sessionKey = f.data.sessionKey;
      pane.classList.add("chat-pane-cache__pane--active");
      await f.send("open-session-actions", target(f.data.sessionKey));
      await vi.dynamicImportSettled();
      await flush();
      f.expectResults();

      if (owner === "superseded") {
        f.select("agent:main:other");
        pane.classList.remove("chat-pane-cache__pane--active");
        pane.active = false;
      } else if (owner === "detached") {
        pane.remove();
      } else if (owner === "retired") {
        f.bridge.dispose();
      }
      await flush();
      const unavailable = [result(false, "request-1", "unavailable")];
      const early = owner === "superseded" || owner === "detached" ? unavailable : [];
      f.expectResults(...early);
      const menu = document.createElement("openclaw-chat-header-session-menu");
      const rendered = createDeferred<boolean>();
      const openMenu = vi.fn(() => true);
      Object.defineProperty(menu, "updateComplete", { value: rendered.promise });
      menu.openMenu = openMenu;
      pane.append(menu);
      f.elements.push(menu);
      await flush();
      expect(openMenu).not.toHaveBeenCalled();
      f.expectResults(...early);
      rendered.resolve(true);
      await flush();
      expect(openMenu).toHaveBeenCalledTimes(owner === "current" ? 1 : 0);
      f.expectResults(...(owner === "current" ? [result(true)] : early));
    },
  );

  it("requires the conversation capability and a callable handler", () => {
    const f = fixture();
    f.bridge.dispose();
    for (const capability of [undefined, { contract: 2 }]) {
      vi.stubGlobal("__OPENCLAW_NATIVE_CONVERSATION__", capability);
      expect(createNativeConversationBridge(f.context)).toBeNull();
    }
    vi.stubGlobal("__OPENCLAW_NATIVE_CONVERSATION__", { contract: 1 });
    vi.stubGlobal("webkit", { messageHandlers: { openclawConversation: { postMessage: false } } });
    expect(createNativeConversationBridge(f.context)).toBeNull();
  });

  it("announces the document before change-only, monotonically revised state", async () => {
    const f = fixture();
    await flush();
    expect(f.messages.map((message) => message.type)).toEqual(["ready", "state"]);
    expect(f.messages[0]).toMatchObject({
      ...f.binding,
      surface: "conversation",
      capabilities: ["navigate", "presentation", "focus-composer"],
    });
    f.changed();
    await flush();
    expect(f.messages).toHaveLength(2);
    f.row.hasActiveRun = true;
    f.changed();
    f.snapshot.phase = "offline";
    f.snapshot.lastErrorAuthReason = "token_missing";
    f.changed();
    await flush();
    expect(f.messagesOf("state")).toMatchObject([
      {
        revision: 1,
        title: "Native conversation",
        run: { active: false },
        connection: "connected",
      },
      { revision: 2, run: { active: true } },
      { revision: 3, connection: "signed-out" },
    ]);
    expect(
      f.messages.every((message) => message.documentId === f.documentId && message.contract === 1),
    ).toBe(true);
  });

  it.each([
    ["presentation", { visible: "yes", active: true }, {}, "invalid-command"],
    ["navigate", { agentId: "main" }, {}, "invalid-command"],
    ["focus-composer", { extra: true }, {}, "invalid-command"],
    ["future-command", {}, {}, "unsupported"],
    ["presentation", { visible: true, active: true }, { contract: 2 }, "unsupported"],
    ["navigate", target(nextSession), { documentId: "old-document" }, "stale-document"],
  ] as const)("rejects %s with %j (%j)", async (type, payload, extra, error) => {
    const f = fixture();
    await f.send(type, payload, extra);
    f.expectResults(result(false, "request-1", error));
    expect(f.navigateAndWait).not.toHaveBeenCalled();
  });

  it("binds same-requestId results to their originating documents", async () => {
    const f = fixture();
    const payload = { visible: false, active: false };
    for (const documentId of ["retired-document", f.documentId, "retired-document", f.documentId]) {
      f.command("presentation", payload, { documentId });
    }
    await flush();
    expect(f.messagesOf("command-result")).toEqual([
      {
        ...result(false, "request-1", "stale-document"),
        ...f.binding,
        documentId: "retired-document",
      },
      { ...result(true), ...f.binding },
    ]);
  });

  it.each(["accepted", "rejected", "timeout"] as const)(
    "awaits state delivery and permits fresh confirmation after %s acknowledgement",
    async (deliveryResult) => {
      vi.useFakeTimers();
      const f = fixture();
      await flush();
      const delivery = createDeferred<unknown>();
      f.reply.mockImplementation((message) =>
        message.type === "state" ? delivery.promise : Promise.resolve(success),
      );
      const destination = target(nextSession);
      f.followNavigation();
      f.navigate(destination.sessionKey);
      if (deliveryResult === "accepted") {
        f.navigate(destination.sessionKey);
      }
      await flush();
      if (deliveryResult === "accepted") {
        expect(f.navigateAndWait).toHaveBeenCalledTimes(1);
        expect(f.navigateAndWait).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({ pathname: expect.stringContaining("/chat/") }),
        );
      }
      f.expectLast({ type: "state", context: { sessionKey: destination.sessionKey } });
      f.expectResults();
      if (deliveryResult === "timeout") {
        await vi.advanceTimersByTimeAsync(15_000);
      } else {
        delivery.resolve(
          deliveryResult === "accepted" ? success : { ok: false, error: "unavailable" },
        );
        await flush();
      }
      if (deliveryResult === "accepted") {
        expect(f.messages.slice(-2)).toMatchObject([
          { type: "state", context: destination },
          result(true),
        ]);
        expect(f.messagesOf("route-changed")).toEqual([]);
        return;
      }
      f.expectLast(result(false, "request-1", `navigate-${deliveryResult}`));
      f.reply.mockResolvedValue(success);
      f.changed();
      await flush();
      expect(f.messagesOf("state")).toHaveLength(2);
      await f.go(destination.sessionKey, "retry");
      expect(f.messages.slice(-2)).toMatchObject([
        { type: "state", revision: 3, context: destination },
        result(true, "retry"),
      ]);
      delivery.resolve({ ok: false, error: "late-rejection" });
      await flush();
      await f.go(destination.sessionKey, "confirmed");
      expect(f.messagesOf("state")).toHaveLength(3);
      f.expectLast(result(true, "confirmed"));
    },
  );

  it.each(["missing target", "superseded", "failed loader", "non-chat route"] as const)(
    "rejects navigation that does not settle on its requested conversation: %s",
    async (failure) => {
      const f = fixture();
      const gate = createDeferred();
      const sessionKey = ["missing target", "superseded"].includes(failure)
        ? nextSession
        : f.data.sessionKey;
      if (failure === "failed loader") {
        f.navigateAndWait.mockRejectedValueOnce(new Error("Session unavailable"));
      } else if (failure === "non-chat route") {
        f.navigateAndWait.mockImplementationOnce(async () => {
          f.match.routeId = "dashboard";
          f.changed();
        });
      } else if (failure === "superseded") {
        f.navigateAndWait.mockReturnValue(gate.promise);
      }
      const requestId = failure === "non-chat route" ? "face" : "request-1";
      await f.go(sessionKey, requestId);
      if (failure === "superseded") {
        f.select("agent:main:web");
        gate.resolve();
        await flush();
        f.expectMessage(result(false, "request-1", "navigate-rejected"));
        f.expectMessage({ type: "route-changed", ...target("agent:main:web") });
      } else {
        f.expectLast(result(false, requestId, "navigate-rejected"));
      }
    },
  );

  it("projects shared global rows only from the selected agent", async () => {
    const f = fixture();
    f.data.sessionKey = "global";
    f.data.agentId = "research";
    f.context.agents.state.agentsList = makeBootRoster({
      scope: "global",
      agents: [{ id: "main" }, { id: "research" }],
    });
    Object.assign(f.row, {
      key: "global",
      agentId: "main",
      label: "Another agent",
      hasActiveRun: true,
    });
    f.context.sessions.presentation.result?.sessions.push({
      key: "global",
      agentId: "research",
      label: "Research conversation",
      hasActiveRun: false,
      kind: "global",
      updatedAt: null,
    });
    f.changed();
    await flush();
    expect(f.messages.findLast((message) => message.type === "state")).toMatchObject({
      context: { agentId: "research", sessionKey: "global" },
      title: "Research conversation",
      run: { active: false },
    });
  });

  it("bounds navigation from receipt, including time waiting behind another command", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await flush();
    f.navigateAndWait.mockReturnValue(new Promise(() => {}));
    await f.go("agent:main:first");
    await vi.advanceTimersByTimeAsync(5_000);
    f.navigate("agent:main:second", "second");
    await vi.advanceTimersByTimeAsync(10_000);
    f.expectMessage(result(false, "request-1", "navigate-timeout"));
    await vi.advanceTimersByTimeAsync(5_000);
    f.expectMessage(result(false, "second", "navigate-timeout"));
  });

  it("settles navigation when the host never acknowledges ready", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.reply.mockImplementation((message) =>
      message.type === "ready" ? new Promise(() => {}) : Promise.resolve(success),
    );
    f.followNavigation();
    await f.go();
    await vi.advanceTimersByTimeAsync(15_000);
    f.expectMessage(result(false, "request-1", "navigate-timeout"));
  });

  it.each(["timeout", "document retirement"] as const)(
    "does not publish a late navigation result after %s",
    async (retirement) => {
      vi.useFakeTimers();
      const f = fixture();
      const first = createDeferred();
      const second = createDeferred();
      f.navigateAndWait.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const destination = target(nextSession);
      await f.go(destination.sessionKey);
      if (retirement === "document retirement") {
        f.bridge.dispose();
        first.resolve();
        await flush();
        expect(f.messagesOf("command-result")).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
        return;
      }
      await vi.advanceTimersByTimeAsync(15_000);
      await f.go(destination.sessionKey, "second");
      f.select(destination.sessionKey);
      const beforeLateCompletion = [...f.messages];
      first.resolve();
      await flush();
      expect(f.messages).toEqual(beforeLateCompletion);
      second.resolve();
      await flush();
      expect(f.messages.slice(-2)).toMatchObject([
        { type: "state", context: destination },
        result(true, "second"),
      ]);
      expect(
        f.messages.filter(
          (message) => message.type === "command-result" && message.requestId === "request-1",
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    [
      true,
      [
        'href="/workspace/notes.md" data-file-path="/workspace/notes.md"',
        'href="/settings"',
        'href="/chat/main/next"',
      ],
    ],
    [
      false,
      [
        "",
        'href="/files/report.txt"',
        'href="/settings" data-file-path="settings"',
        'href="/settings" download',
        'href="/settings" target="_blank"',
        'href="https://example.com/settings"',
        'href="/chat/main/next"',
      ],
    ],
  ] as const)(
    "only hands unclaimed application links to Dashboard (claimed: %s)",
    async (claimed, attributes) => {
      const f = fixture();
      for (const attribute of attributes) {
        document.body.innerHTML = `<a ${attribute}>Link</a>`;
        const anchor = document.querySelector("a")!;
        const handled = vi.fn((event: MouseEvent) => {
          if (!claimed) {
            expect(event.defaultPrevented).toBe(false);
          }
          event.preventDefault();
        });
        if (claimed) {
          anchor.addEventListener("click", handled);
        } else {
          window.addEventListener("click", handled, { once: true });
        }
        anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        window.removeEventListener("click", handled);
        expect(handled).toHaveBeenCalledOnce();
      }
      await flush();
      expect(f.messagesOf("open-dashboard")).toEqual([]);
      expect(f.navigateAndWait).not.toHaveBeenCalled();
      if (!claimed) {
        document.body.innerHTML = '<a href="/settings?section=general">Settings</a>';
        const click = new MouseEvent("click", { bubbles: true, cancelable: true });
        document.querySelector("a")!.dispatchEvent(click);
        await flush();
        expect(click.defaultPrevented).toBe(true);
        f.expectLast({
          type: "open-dashboard",
          path: "/settings",
          search: "?section=general",
        });
      }
    },
  );

  it.each(["rejected", "throwing"] as const)(
    "shows a toast when Dashboard handoff is %s",
    async (failure) => {
      const f = fixture();
      await flush();
      f.reply.mockImplementation((message) => {
        if (message.type !== "open-dashboard") {
          return Promise.resolve(success);
        }
        return failure === "rejected"
          ? Promise.resolve({ ok: false, error: "unavailable" })
          : Promise.reject(new Error("Dashboard unavailable"));
      });
      f.bridge.interceptNavigation(location("/settings"));
      await flush();
      expect(showToast).toHaveBeenCalledWith({
        message: "Couldn't open that page in the Dashboard",
      });
      expect(f.navigateAndWait).not.toHaveBeenCalled();
      expect(f.data.sessionKey).toBe("agent:main:main");
    },
  );

  it("reports route changes and hands non-chat navigation to Dashboard", async () => {
    const f = fixture();
    f.match.status = "pending";
    f.changed();
    f.data.sessionKey = "agent:main:linked";
    f.match.status = "success";
    f.changed();
    expect(f.bridge.interceptNavigation(location("/settings", "?section=general"))).toBe(true);
    expect(f.bridge.interceptNavigation(location("/chat"))).toBe(false);
    await flush();
    expect(f.messages).toContainEqual({
      ...f.binding,
      type: "route-changed",
      ...target("agent:main:linked"),
      reason: "other",
    });
    f.expectLast({
      type: "open-dashboard",
      path: "/settings",
      search: "?section=general",
    });
  });

  it("applies presentation and focuses the existing composer", async () => {
    const f = fixture();
    const pane = f.mountPane();
    const composer = document.createElement("textarea");
    pane.focusComposerInput = () => {
      composer.focus({ preventScroll: true });
      return true;
    };
    pane.append(composer);
    const listener = vi.fn();
    f.bridge.subscribe(listener);
    await f.send("presentation", { visible: false, active: false });
    expect(f.bridge.presentation).toEqual({ visible: false, active: false });
    expect(listener).toHaveBeenCalledTimes(1);
    f.command("presentation", { visible: true, active: true }, { requestId: "show" });
    f.command("focus-composer", {}, { requestId: "focus" });
    await flush();
    expect(document.activeElement).toBe(composer);
    f.expectLast(result(true, "focus"));
  });
});
