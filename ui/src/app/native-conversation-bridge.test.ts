/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { showToast } from "../lib/toast.ts";
import type { ApplicationContext } from "./context.ts";
import { createNativeConversationBridge } from "./native-conversation-bridge.ts";

vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));

const cleanups: Array<() => void> = [];
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
  const context = {
    basePath: "",
    gateway: { snapshot, subscribe },
    router: {
      getState: () => ({
        matches: [match],
        pendingMatches: [],
      }),
      subscribe,
    },
    sessions: {
      presentation: { result: { sessions: [row] } },
      state: { result: { sessions: [row] } },
      subscribe,
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
    Promise.resolve({ ok: true }),
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
  return {
    messages,
    reply,
    bridge,
    documentId,
    command,
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
    expect(old.messages.some((message) => message.type === "session-facts")).toBe(false);
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
    expect(f.messages.filter((message) => message.type === "session-facts")).toEqual([
      {
        contract: 1,
        documentId: f.documentId,
        type: "session-facts",
        revision: 1,
        sessions: [row],
      },
    ]);
    f.bridge.publishSessionFacts([]);
    await flush();
    expect(f.messages.at(-1)).toMatchObject({ revision: 2, sessions: [] });
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
      expect(f.messages.at(-1)).toMatchObject({ type: "session-facts", sessions: null });
    }
    f.bridge.dispose();
    const count = f.messages.length;
    f.bridge.publishSessionFacts([row]);
    await flush();
    expect(f.messages).toHaveLength(count);
  });

  it("rejects unadvertised or hidden session action commands before navigation", async () => {
    const old = fixture();
    old.command("open-session-actions", old.data);
    await flush();
    expect(old.navigateAndWait).not.toHaveBeenCalled();
    expect(old.messages.find((message) => message.type === "command-result")).toMatchObject({
      error: "unsupported",
    });
    old.bridge.dispose();
    const f = fixture(["session-actions-v1"]);
    f.command("presentation", { visible: false, active: false });
    await flush();
    f.command(
      "open-session-actions",
      { agentId: "main", sessionKey: f.data.sessionKey },
      { requestId: "hidden" },
    );
    await flush();
    expect(f.navigateAndWait).not.toHaveBeenCalled();
    expect(
      f.messages.find(
        (message) => message.type === "command-result" && message.requestId === "hidden",
      ),
    ).toMatchObject({
      type: "command-result",
      requestId: "hidden",
      error: "unavailable",
    });
  });

  it.each(["current", "superseded", "detached", "retired"] as const)(
    "waits for rendered session actions without opening a stale menu (%s)",
    async (owner) => {
      const f = fixture(["session-actions-v1"]);
      const page = document.createElement("openclaw-chat-page");
      const pane = document.createElement("openclaw-chat-pane");
      pane.sessionKey = f.data.sessionKey;
      pane.classList.add("chat-pane-cache__pane--active");
      page.append(pane);
      document.body.append(page);
      const results = () => f.messages.filter((message) => message.type === "command-result");
      f.command("open-session-actions", {
        agentId: f.data.agentId,
        sessionKey: f.data.sessionKey,
      });
      await flush();
      await vi.dynamicImportSettled();
      await flush();
      expect(results()).toEqual([]);

      if (owner === "superseded") {
        f.data.sessionKey = "agent:main:other";
        f.changed();
        // The pane cache retains the prior session's pane and moves only its class.
        pane.classList.remove("chat-pane-cache__pane--active");
      } else if (owner === "detached") {
        pane.remove();
      } else if (owner === "retired") {
        f.bridge.dispose();
      }
      await flush();
      // A retired pane settles the command now, not at the response deadline.
      expect(results()).toMatchObject(
        owner === "superseded" || owner === "detached"
          ? [{ requestId: "request-1", ok: false, error: "unavailable" }]
          : [],
      );
      const menu = document.createElement("openclaw-chat-header-session-menu");
      const dropdown = document.createElement("wa-dropdown");
      dropdown.open = false;
      menu.append(dropdown);
      pane.append(menu);
      await flush();
      expect(dropdown.open).toBe(owner === "current");
      if (owner === "current") {
        expect(results()).toEqual([]);
        dropdown.dispatchEvent(new Event("wa-after-show"));
        await flush();
        expect(results()).toMatchObject([{ requestId: "request-1", ok: true }]);
      } else {
        expect(results()).toHaveLength(owner === "retired" ? 0 : 1);
      }
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
      contract: 1,
      documentId: f.documentId,
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
    expect(f.messages.filter((message) => message.type === "state")).toMatchObject([
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
    [
      "navigate",
      { agentId: "main", sessionKey: "agent:main:other" },
      { documentId: "old-document" },
      "stale-document",
    ],
  ] as const)("rejects %s with %j (%j)", async (type, payload, extra, error) => {
    const f = fixture();
    f.command(type, payload, extra);
    await flush();
    expect(f.messages.find((message) => message.type === "command-result")).toMatchObject({
      type: "command-result",
      requestId: "request-1",
      ok: false,
      error,
    });
    expect(f.navigateAndWait).not.toHaveBeenCalled();
  });

  it("binds same-requestId results to their originating documents", async () => {
    const f = fixture();
    const payload = { visible: false, active: false };
    for (const documentId of ["retired-document", f.documentId, "retired-document", f.documentId]) {
      f.command("presentation", payload, { documentId });
    }
    await flush();
    expect(f.messages.filter((message) => message.type === "command-result")).toEqual([
      {
        contract: 1,
        documentId: "retired-document",
        type: "command-result",
        requestId: "request-1",
        ok: false,
        error: "stale-document",
      },
      {
        contract: 1,
        documentId: f.documentId,
        type: "command-result",
        requestId: "request-1",
        ok: true,
      },
    ]);
  });

  it("switches through the in-page owner once and publishes state before answering once", async () => {
    const f = fixture();
    const gate = createDeferred();
    f.navigateAndWait.mockImplementation(async () => {
      await gate.promise;
      f.data.sessionKey = "agent:main:next";
      f.changed();
    });
    f.command("navigate", { agentId: "main", sessionKey: "agent:main:next" });
    f.command("navigate", { agentId: "main", sessionKey: "agent:main:next" });
    await flush();
    expect(f.navigateAndWait).toHaveBeenCalledTimes(1);
    expect(f.navigateAndWait).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: expect.stringContaining("/chat/") }),
    );
    expect(f.messages.some((message) => message.type === "command-result")).toBe(false);
    gate.resolve();
    await flush();
    expect(f.messages.slice(-2)).toMatchObject([
      { type: "state", context: { agentId: "main", sessionKey: "agent:main:next" } },
      { type: "command-result", ok: true },
    ]);
    expect(f.messages.some((message) => message.type === "route-changed")).toBe(false);
  });

  it.each(["accepted", "rejected", "timeout"] as const)(
    "awaits state delivery and permits fresh confirmation after %s acknowledgement",
    async (deliveryResult) => {
      vi.useFakeTimers();
      const f = fixture();
      await flush();
      const delivery = createDeferred<unknown>();
      f.reply.mockImplementation((message) =>
        message.type === "state" ? delivery.promise : Promise.resolve({ ok: true }),
      );
      const target = { agentId: "main", sessionKey: "agent:main:next" };
      f.navigateAndWait.mockImplementation(async () => {
        f.data.sessionKey = target.sessionKey;
        f.changed();
      });
      f.command("navigate", target);
      await flush();
      expect(f.messages.at(-1)).toMatchObject({
        type: "state",
        context: { sessionKey: target.sessionKey },
      });
      expect(f.messages.some((message) => message.type === "command-result")).toBe(false);
      if (deliveryResult === "timeout") {
        await vi.advanceTimersByTimeAsync(15_000);
      } else {
        delivery.resolve(
          deliveryResult === "accepted" ? { ok: true } : { ok: false, error: "unavailable" },
        );
        await flush();
      }
      expect(f.messages.at(-1)).toMatchObject({
        type: "command-result",
        ok: deliveryResult === "accepted",
        ...(deliveryResult === "accepted"
          ? {}
          : { error: deliveryResult === "timeout" ? "navigate-timeout" : "navigate-rejected" }),
      });
      if (deliveryResult === "accepted") {
        return;
      }
      f.reply.mockResolvedValue({ ok: true });
      f.changed();
      await flush();
      expect(f.messages.filter((message) => message.type === "state")).toHaveLength(2);
      f.command("navigate", target, { requestId: "retry" });
      await flush();
      expect(f.messages.slice(-2)).toMatchObject([
        { type: "state", revision: 3, context: target },
        { type: "command-result", requestId: "retry", ok: true },
      ]);
      delivery.resolve({ ok: false, error: "late-rejection" });
      await flush();
      f.command("navigate", target, { requestId: "confirmed" });
      await flush();
      expect(f.messages.filter((message) => message.type === "state")).toHaveLength(3);
      expect(f.messages.at(-1)).toMatchObject({
        type: "command-result",
        requestId: "confirmed",
        ok: true,
      });
    },
  );

  it.each(["missing target", "superseded", "failed loader", "non-chat route"] as const)(
    "rejects navigation that does not settle on its requested conversation: %s",
    async (failure) => {
      const f = fixture();
      const gate = createDeferred();
      const target =
        failure === "missing target"
          ? "agent:main:missing"
          : failure === "superseded"
            ? "agent:main:native"
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
      f.command(
        "navigate",
        { agentId: "main", sessionKey: target },
        { requestId: failure === "non-chat route" ? "face" : "request-1" },
      );
      await flush();
      if (failure === "superseded") {
        f.data.sessionKey = "agent:main:web";
        f.changed();
        gate.resolve();
        await flush();
        expect(f.messages).toContainEqual(
          expect.objectContaining({
            type: "command-result",
            ok: false,
            error: "navigate-rejected",
          }),
        );
        expect(f.messages).toContainEqual(
          expect.objectContaining({
            type: "route-changed",
            agentId: "main",
            sessionKey: "agent:main:web",
          }),
        );
      } else {
        expect(f.messages.at(-1)).toMatchObject({
          type: "command-result",
          ok: false,
          error: "navigate-rejected",
          ...(failure === "non-chat route" ? { requestId: "face" } : {}),
        });
      }
    },
  );

  it("projects shared global rows only from the selected agent", async () => {
    const f = fixture();
    f.data.sessionKey = "global";
    f.data.agentId = "research";
    f.context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "main" }, { id: "research" }],
    };
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
    f.command("navigate", { agentId: "main", sessionKey: "agent:main:first" });
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    f.command(
      "navigate",
      { agentId: "main", sessionKey: "agent:main:second" },
      { requestId: "second" },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.messages).toContainEqual(
      expect.objectContaining({
        type: "command-result",
        requestId: "request-1",
        ok: false,
        error: "navigate-timeout",
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.messages).toContainEqual(
      expect.objectContaining({
        type: "command-result",
        requestId: "second",
        ok: false,
        error: "navigate-timeout",
      }),
    );
  });

  it.each(["ready", "state"] as const)(
    "settles navigation when the host never acknowledges %s",
    async (stalledType) => {
      vi.useFakeTimers();
      const f = fixture();
      if (stalledType === "state") {
        await flush();
      }
      f.reply.mockImplementation((message) =>
        message.type === stalledType ? new Promise(() => {}) : Promise.resolve({ ok: true }),
      );
      f.navigateAndWait.mockImplementation(async () => {
        f.data.sessionKey = "agent:main:next";
        f.changed();
      });
      f.command("navigate", { agentId: "main", sessionKey: "agent:main:next" });
      await flush();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.messages).toContainEqual(
        expect.objectContaining({
          type: "command-result",
          requestId: "request-1",
          ok: false,
          error: "navigate-timeout",
        }),
      );
    },
  );

  it.each(["timeout", "document retirement"] as const)(
    "does not publish a late navigation result after %s",
    async (retirement) => {
      vi.useFakeTimers();
      const f = fixture();
      const first = createDeferred();
      const second = createDeferred();
      f.navigateAndWait.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const target = { agentId: "main", sessionKey: "agent:main:next" };
      f.command("navigate", target);
      await flush();
      if (retirement === "document retirement") {
        f.bridge.dispose();
        first.resolve();
        await flush();
        expect(f.messages.some((message) => message.type === "command-result")).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        return;
      }
      await vi.advanceTimersByTimeAsync(15_000);
      f.command("navigate", target, { requestId: "second" });
      await flush();
      f.data.sessionKey = target.sessionKey;
      f.changed();
      const beforeLateCompletion = [...f.messages];
      first.resolve();
      await flush();
      expect(f.messages).toEqual(beforeLateCompletion);
      second.resolve();
      await flush();
      expect(f.messages.slice(-2)).toMatchObject([
        { type: "state", context: target },
        { type: "command-result", requestId: "second", ok: true },
      ]);
      expect(
        f.messages.filter(
          (message) => message.type === "command-result" && message.requestId === "request-1",
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    {
      claimed: true,
      markups: [
        '<a href="/workspace/notes.md" data-file-path="/workspace/notes.md">Transcript file</a>',
        '<a href="/settings">Existing panel action</a>',
        '<a href="/chat/main/next">In-pane session</a>',
      ],
    },
    {
      claimed: false,
      markups: [
        "<a>Action without href</a>",
        '<a href="/files/report.txt">Non-route file</a>',
        '<a href="/settings" data-file-path="settings">Workspace file</a>',
        '<a href="/settings" download>Download</a>',
        '<a href="/settings" target="_blank">New window</a>',
        '<a href="https://example.com/settings">External</a>',
        '<a href="/chat/main/next">Conversation</a>',
      ],
    },
  ])(
    "only hands unclaimed application links to Dashboard (claimed: $claimed)",
    async ({ claimed, markups }) => {
      const f = fixture();
      for (const markup of markups) {
        document.body.innerHTML = markup;
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
      expect(f.messages.some((message) => message.type === "open-dashboard")).toBe(false);
      expect(f.navigateAndWait).not.toHaveBeenCalled();
      if (!claimed) {
        document.body.innerHTML = '<a href="/settings?section=general">Settings</a>';
        const click = new MouseEvent("click", { bubbles: true, cancelable: true });
        document.querySelector("a")!.dispatchEvent(click);
        await flush();
        expect(click.defaultPrevented).toBe(true);
        expect(f.messages.at(-1)).toMatchObject({
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
          return Promise.resolve({ ok: true });
        }
        return failure === "rejected"
          ? Promise.resolve({ ok: false, error: "unavailable" })
          : Promise.reject(new Error("Dashboard unavailable"));
      });
      f.bridge.interceptNavigation({ pathname: "/settings", search: "", hash: "" });
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
    expect(
      f.bridge.interceptNavigation({ pathname: "/settings", search: "?section=general", hash: "" }),
    ).toBe(true);
    expect(f.bridge.interceptNavigation({ pathname: "/chat", search: "", hash: "" })).toBe(false);
    await flush();
    expect(f.messages).toContainEqual({
      contract: 1,
      documentId: f.documentId,
      type: "route-changed",
      agentId: "main",
      sessionKey: "agent:main:linked",
      reason: "other",
    });
    expect(f.messages.at(-1)).toMatchObject({
      type: "open-dashboard",
      path: "/settings",
      search: "?section=general",
    });
  });

  it("applies presentation and focuses the existing composer", async () => {
    const f = fixture();
    document.body.innerHTML =
      '<openclaw-chat-pane class="chat-pane-cache__pane--active"><div class="agent-chat__composer-combobox"><textarea></textarea></div></openclaw-chat-pane>';
    const listener = vi.fn();
    f.bridge.subscribe(listener);
    f.command("presentation", { visible: false, active: false });
    await flush();
    expect(f.bridge.presentation).toEqual({ visible: false, active: false });
    expect(listener).toHaveBeenCalledTimes(1);
    f.command("presentation", { visible: true, active: true }, { requestId: "show" });
    f.command("focus-composer", {}, { requestId: "focus" });
    await flush();
    expect(document.activeElement).toBe(document.querySelector("textarea"));
    expect(f.messages.at(-1)).toMatchObject({
      type: "command-result",
      requestId: "focus",
      ok: true,
    });
  });
});
