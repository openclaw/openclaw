// Exercises the pure stream-assembly helpers extracted from the Linux Quick Chat webview script.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { it as test } from "vitest";

const quickchatSource = readFileSync(
  new URL("../apps/linux/ui/quickchat.js", import.meta.url),
  "utf8",
);
const tauriConfig = JSON.parse(
  readFileSync(new URL("../apps/linux/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
) as {
  app?: {
    security?: {
      capabilities?: Array<{
        identifier?: string;
        windows?: string[];
        webviews?: string[];
      }>;
    };
  };
};
const browserBindingsStart = quickchatSource.indexOf("const tauri = window");
assert.notEqual(browserBindingsStart, -1, "quickchat pure-helper boundary");

type QuickChatHelpers = {
  assembleChatDelta: (state: unknown, payload: unknown) => unknown;
  chatMessageText: (message: unknown) => string;
  chatMessageWidgets: (message: unknown) => unknown[];
  resolveInlineWidgetUrl: (surface: unknown, target: unknown) => string | null;
};

const context: { helpers?: QuickChatHelpers } & Record<string, unknown> = { URL, TextEncoder };
vm.runInNewContext(
  `${quickchatSource.slice(0, browserBindingsStart)}\nthis.helpers = { assembleChatDelta, chatMessageText, chatMessageWidgets, resolveInlineWidgetUrl };`,
  context,
);
const { assembleChatDelta, chatMessageText, chatMessageWidgets, resolveInlineWidgetUrl } =
  context.helpers as {
    assembleChatDelta: (state: unknown, payload: unknown) => { text: string; runId?: string };
    chatMessageText: (message: unknown) => string;
    chatMessageWidgets: (message: unknown) => Array<{
      key: string;
      title: string;
      target: string;
      preferredHeight: number;
      sandbox: string;
    }>;
    resolveInlineWidgetUrl: (surface: unknown, target: unknown) => string | null;
  };

function createFakeElement(tagName = "div") {
  const classes = new Set();
  const children: any[] = [];
  const styles = new Map<string, string>();
  return {
    tagName: tagName.toUpperCase(),
    children,
    dataset: {},
    className: "",
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      toggle(name: string, force?: boolean) {
        const enabled = force ?? !classes.has(name);
        if (enabled) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return enabled;
      },
    },
    style: {
      setProperty(name: string, value: string) {
        styles.set(name, value);
      },
      removeProperty(name: string) {
        styles.delete(name);
      },
      getPropertyValue(name: string) {
        return styles.get(name) ?? "";
      },
    },
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    readOnly: false,
    scrollHeight: 0,
    scrollTop: 0,
    src: "",
    title: "",
    referrerPolicy: "",
    contentWindow: tagName === "iframe" ? {} : null,
    addEventListener() {},
    append(...nodes: any[]) {
      children.push(...nodes);
    },
    contains() {
      return false;
    },
    focus() {},
    getBoundingClientRect() {
      return { x: 52, y: 174, width: 540, height: 160 };
    },
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector: string) {
      return children
        .flatMap((child) => [child, ...(child.querySelectorAll?.(selector) ?? [])])
        .filter((child) =>
          selector.startsWith(".")
            ? child.className.split(/\s+/u).includes(selector.slice(1))
            : child.tagName === selector.toUpperCase(),
        );
    },
    replaceChildren(...nodes: any[]) {
      children.splice(0, children.length, ...nodes);
    },
    setAttribute() {},
  };
}

function createQuickChatHarness(): Record<string, any> {
  const browserBindingsEnd = quickchatSource.indexOf("elements.input.addEventListener");
  assert.notEqual(browserBindingsEnd, -1, "quickchat browser binding boundary");
  const elements = new Map();
  const sends: Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  let syncedWidgets: unknown[] = [];
  let syncedHasWidgets = false;
  let syncedExpanded = false;
  let syncedGeneration = 0;
  let widgetSyncCount = 0;
  let widgetSurfaceRefreshCount = 0;
  let widgetSurfaceRefreshFails = false;
  let widgetSurfaceRefreshResult = "https://gateway.example/__openclaw__/cap/refreshed-capability";
  let fakeNow = 1_000_000;
  let timerId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const frames = new Map<number, () => void>();
  const microtasks = async () => {
    for (let i = 0; i < 16; i += 1) {
      await Promise.resolve();
    }
  };
  const drain = async () => {
    for (let batch = 0; batch < 32; batch += 1) {
      await microtasks();
      if (frames.size === 0) {
        return;
      }
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback());
    }
    assert.fail("renderer exceeded 32 RAF batches");
  };
  const Date = { now: () => fakeNow };
  const window = {
    __TAURI__: {
      core: {
        invoke(
          method: string,
          args?: {
            widgets?: unknown[];
            hasWidgets?: boolean;
            expanded?: boolean;
            sessionId?: string;
            rendererEpoch?: number;
            generation?: number;
          },
        ) {
          if (method === "quickchat_send") {
            return new Promise((resolve, reject) => {
              sends.push({ resolve, reject });
            });
          }
          if (method === "quickchat_refresh_widget_surface") {
            widgetSurfaceRefreshCount += 1;
            return widgetSurfaceRefreshFails
              ? Promise.reject(new Error("refresh failed"))
              : Promise.resolve(widgetSurfaceRefreshResult);
          }
          if (method === "quickchat_sync_widgets") {
            syncedWidgets = args?.widgets ?? [];
            syncedHasWidgets = args?.hasWidgets === true;
            syncedExpanded = args?.expanded === true;
            syncedGeneration = args?.generation ?? 0;
            widgetSyncCount += 1;
          }
          if (method === "quickchat_agents") {
            return Promise.resolve([]);
          }
          if (method === "quickchat_identity") {
            return Promise.resolve({ id: "work", name: "Work", isDefault: true });
          }
          return Promise.resolve(true);
        },
      },
      event: { listen: async () => () => {} },
    },
    addEventListener() {},
    clearTimeout(id: number) {
      timers.delete(id);
    },
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame(callback: () => void) {
      const id = ++timerId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
    setTimeout(callback: () => void, ms: number) {
      const id = ++timerId;
      timers.set(id, { at: fakeNow + ms, callback });
      return id;
    },
  };
  const document = {
    body: createFakeElement(),
    documentElement: createFakeElement("html"),
    createElement: (tagName: string) => createFakeElement(tagName),
    createTextNode: (text: string) => ({ textContent: text }),
    querySelector(selector: string) {
      if (!elements.has(selector)) {
        elements.set(selector, createFakeElement());
      }
      return elements.get(selector);
    },
  };
  const advanceTime = async (ms: number) => {
    const until = fakeNow + ms;
    for (let batch = 0; batch < 128; batch += 1) {
      await drain();
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .toSorted((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) {
        fakeNow = until;
        await drain();
        return;
      }
      fakeNow = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    assert.fail("renderer exceeded 128 timer batches");
  };
  const browserContext: Record<string, any> = {
    advanceTime,
    document,
    window,
    Date,
    URL,
    TextEncoder,
  };
  vm.runInNewContext(
    `${quickchatSource.slice(0, browserBindingsEnd)}
this.harness = {
  send,
  handleChatEvent(payload) { handleChatEvent({gatewayGeneration: 1, ...payload}); },
  nextVisibilityOperation,
  requestHide,
  clearReply,
  setGatewayUp(surface = "https://gateway.example/__openclaw__/cap/fixture-capability", gatewayGeneration = 1) {
    setGatewayState({state: "up", canvasSurfaceUrl: surface, gatewayGeneration});
    if (visibilitySequence === 0) reveal();
  },
  advanceTime(ms) { return advanceTime(ms); },
  emitGatewayState(payload) { setGatewayState({gatewayGeneration: 1, ...payload}); },
  accent() { return document.documentElement.style.getPropertyValue("--accent"); },
  setMessage(value) { elements.input.value = value; },
  pendingCount() { return pendingChatEvents.length; },
  activeRunId() { return activeReply?.runId ?? null; },
  replyText() { return elements.replyText.textContent; },
  readOnly() { return elements.input.readOnly; },
  thinking() { return !elements.replyThinking.hidden; },
  draft() { return elements.input.value; },
  error() { return elements.status.textContent; },
  reveal,
  expireCanvasSurface() { canvasSurfaceRefreshedAt = 0; canvasSurfaceRetryAt = 0; },
  allowCanvasSurfaceRetry() { canvasSurfaceRetryAt = 0; },
  flushSurfaceRefresh() { return canvasSurfaceRefreshPromise ?? Promise.resolve(); },
  flushWidgets() { return widgetSyncPromise; },
};`,
    browserContext,
  );
  return {
    ...(browserContext.harness as Record<string, (...args: any[]) => any>),
    resolveSend: (value: Record<string, unknown>, index = sends.length - 1) => {
      const pending = sends[index];
      assert.ok(pending, "send invocation exists");
      pending.resolve({ gatewayGeneration: 1, status: "started", ...value });
    },
    rejectSend: (message: string, index = sends.length - 1) => {
      const pending = sends[index];
      assert.ok(pending, "send invocation exists");
      pending.reject(new Error(message));
    },
    sendCount: () => sends.length,
    drain,
    flushWidgets: async () => {
      await drain();
      await browserContext.harness.flushWidgets();
      await drain();
    },
    syncedWidgets: () => syncedWidgets,
    syncedHasWidgets: () => syncedHasWidgets,
    syncedExpanded: () => syncedExpanded,
    syncedGeneration: () => syncedGeneration,
    widgetSyncCount: () => widgetSyncCount,
    widgetSurfaceRefreshCount: () => widgetSurfaceRefreshCount,
    setWidgetSurfaceRefreshFails: (value: boolean) => {
      widgetSurfaceRefreshFails = value;
    },
    setWidgetSurfaceRefreshResult: (value: string) => {
      widgetSurfaceRefreshResult = value;
    },
  };
}

test("visibility operations share one monotonic sequence", () => {
  const harness = createQuickChatHarness();
  assert.equal(harness.nextVisibilityOperation(), 1);
  assert.equal(harness.nextVisibilityOperation(), 2);
  assert.equal(harness.nextVisibilityOperation(), 3);
});

test("gateway state updates and clears the Quick Chat user accent", () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();

  harness.emitGatewayState({ state: "up", accent: "#45b6fe" });
  assert.equal(harness.accent(), "#45b6fe");

  harness.emitGatewayState({ state: "up", accent: "#52c99a" });
  assert.equal(harness.accent(), "#52c99a");

  harness.emitGatewayState({ state: "up" });
  assert.equal(harness.accent(), "");
});

test("widget child webviews inherit no Quick Chat Tauri capability", () => {
  const capability = tauriConfig.app?.security?.capabilities?.find(
    (candidate) => candidate.identifier === "quickchat",
  );

  assert.deepEqual(capability?.webviews, ["quickchat"]);
  assert.equal(capability?.windows, undefined);
  assert.equal(
    capability?.webviews?.some((label) => label.startsWith("quickchat-widget-")),
    false,
  );
});

test("replace deltas are authoritative", () => {
  assert.equal(
    assembleChatDelta("stale", {
      deltaText: "replacement",
      replace: true,
      message: { content: [{ type: "text", text: "ignored snapshot" }] },
    }),
    "replacement",
  );
});

test("the first delta seeds from its message snapshot", () => {
  assert.equal(
    assembleChatDelta(null, {
      deltaText: "lo",
      message: { content: [{ type: "text", text: "Hello" }] },
    }),
    "Hello",
  );
  assert.equal(assembleChatDelta(null, { deltaText: "Hi" }), "Hi");
});

test("matching deltas append and mismatched snapshots self-heal", () => {
  assert.equal(
    assembleChatDelta("Hello", {
      deltaText: "!",
      message: { content: [{ type: "text", text: "Hello!" }] },
    }),
    "Hello!",
  );
  assert.equal(
    assembleChatDelta("Hellx", {
      deltaText: "!",
      message: { content: [{ type: "text", text: "Hello!" }] },
    }),
    "Hello!",
  );
});

test("snapshot-only terminal frames replace the assembled text", () => {
  assert.equal(
    assembleChatDelta("partial", {
      message: { content: [{ type: "text", text: "complete" }] },
    }),
    "complete",
  );
});

test("snapshot extraction joins every text block", () => {
  assert.equal(
    chatMessageText({
      content: [
        { type: "text", text: "first" },
        { type: "image", url: "data:image/png;base64,AA==" },
        { type: "text", text: "second" },
      ],
    }),
    "first\n\nsecond",
  );
});

test("snapshot extraction skips a leading non-text block", () => {
  assert.equal(
    chatMessageText({
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "visible" },
      ],
    }),
    "visible",
  );
});

test("snapshot extraction falls back through string content and top-level text", () => {
  assert.equal(chatMessageText({ content: "string content", text: "top-level" }), "string content");
  assert.equal(chatMessageText({ content: [], text: "top-level" }), "top-level");
});

test("canvas previews are accepted only for safe assistant widgets", () => {
  const [widget] = chatMessageWidgets({
    role: "assistant",
    content: [
      {
        type: "canvas",
        preview: {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          sandbox: "scripts",
          title: "Build status",
          preferredHeight: 2_000,
          viewId: "build-status",
          url: "/__openclaw__/canvas/documents/build-status/index.html",
        },
      },
    ],
  });

  assert.deepEqual(
    { ...widget },
    {
      key: "build-status",
      title: "Build status",
      target: "/__openclaw__/canvas/documents/build-status/index.html",
      preferredHeight: 1_200,
      sandbox: "scripts",
    },
  );
  const duplicateWidgets = chatMessageWidgets({
    role: "assistant",
    content: [
      {
        type: "canvas",
        preview: {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          sandbox: "scripts",
          viewId: "duplicate",
          url: "/__openclaw__/canvas/documents/first/index.html",
        },
      },
      {
        type: "canvas",
        preview: {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          sandbox: "scripts",
          viewId: "duplicate",
          url: "/__openclaw__/canvas/documents/second/index.html",
        },
      },
      {
        type: "canvas",
        preview: {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          sandbox: "scripts",
          viewId: "duplicate-2",
          url: "/__openclaw__/canvas/documents/third/index.html",
        },
      },
    ],
  });
  assert.equal(duplicateWidgets.length, 3);
  assert.equal(duplicateWidgets[0]?.key, "duplicate");
  assert.equal(duplicateWidgets[1]?.key, "duplicate-2");
  assert.equal(duplicateWidgets[2]?.key, "duplicate-2-2");
  assert.equal(
    new Set(duplicateWidgets.map((candidate) => candidate.key)).size,
    duplicateWidgets.length,
  );
  const emojiViewId = "🦞".repeat(65);
  const [emojiWidget] = chatMessageWidgets({
    role: "assistant",
    content: [
      {
        type: "canvas",
        preview: {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          sandbox: "scripts",
          viewId: emojiViewId,
          url: "/__openclaw__/canvas/documents/emoji/index.html",
        },
      },
    ],
  });
  assert.notEqual(emojiWidget?.key, emojiViewId);
  assert.ok(Buffer.byteLength(emojiWidget?.key ?? "", "utf8") <= 256);
  const cjkViewId = "界".repeat(201);
  const [cjkWidget] = chatMessageWidgets({
    role: "assistant",
    content: [
      {
        type: "canvas",
        preview: {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          sandbox: "scripts",
          viewId: cjkViewId,
          url: "/__openclaw__/canvas/documents/cjk/index.html",
        },
      },
    ],
  });
  assert.notEqual(cjkWidget?.key, cjkViewId);
  assert.ok(Buffer.byteLength(cjkWidget?.key ?? "", "utf8") <= 256);
  assert.equal(
    chatMessageWidgets({
      role: "tool",
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            sandbox: "scripts",
            url: "/__openclaw__/canvas/documents/tool/index.html",
          },
        },
      ],
    }).length,
    0,
  );
  assert.equal(
    chatMessageWidgets({
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            sandbox: "scripts",
            url: "/__openclaw__/canvas/documents/roleless/index.html",
          },
        },
      ],
    }).length,
    0,
  );
  assert.equal(
    chatMessageWidgets({
      role: "assistant",
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            sandbox: "scripts",
            url: "/__openclaw__/canvas/documents/%252e%252e/private-file",
          },
        },
      ],
    }).length,
    0,
  );
});

test("widget URLs stay inside the capability-scoped Canvas host", () => {
  assert.equal(
    resolveInlineWidgetUrl(
      "https://gateway.example/base/__openclaw__/cap/fixture-capability",
      "/__openclaw__/canvas/documents/widget-1/index.html?mode=compact#result",
    ),
    "https://gateway.example/base/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/widget-1/index.html?mode=compact#result",
  );
  assert.equal(
    resolveInlineWidgetUrl(
      "http://gateway.example/__openclaw__/cap/fixture-capability",
      "/__openclaw__/canvas/documents/widget-1/index.html",
    ),
    null,
  );
  assert.equal(
    resolveInlineWidgetUrl(
      "http://localhost:18789/__openclaw__/cap/fixture-capability",
      "/__openclaw__/canvas/documents/widget-1/index.html",
    ),
    "http://localhost:18789/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/widget-1/index.html",
  );
  assert.equal(
    resolveInlineWidgetUrl(
      "http://[::1]:18789/__openclaw__/cap/fixture-capability",
      "/__openclaw__/canvas/documents/widget-1/index.html",
    ),
    "http://[::1]:18789/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/widget-1/index.html",
  );
  assert.equal(
    resolveInlineWidgetUrl(
      "https://gateway.example/base/__openclaw__/cap/fixture-capability?leak=1",
      "/__openclaw__/canvas/documents/widget-1/index.html",
    ),
    null,
  );
  assert.equal(
    resolveInlineWidgetUrl(
      "https://gateway.example/base/__openclaw__/cap/%252f..%252fother",
      "/__openclaw__/canvas/documents/widget-1/index.html",
    ),
    null,
  );
  assert.equal(
    resolveInlineWidgetUrl(
      "https://gateway.example/base/__openclaw__/cap/fixture-capability",
      "https://evil.example/widget.html",
    ),
    null,
  );
});

test("a cached terminal retry presents the recovered reply and unlocks without another event", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.setMessage("recover my reply");
  const first = harness.send(false);
  harness.rejectSend("ACK connection closed");
  await first;
  assert.equal(harness.draft(), "recover my reply");
  harness.emitGatewayState({ state: "down" });
  await harness.drain();
  harness.setGatewayUp();
  const retry = harness.send(false);
  harness.resolveSend({
    sessionKey: "global",
    agentId: "work",
    runId: "retained-key",
    status: "ok",
    recoveredMessages: [
      { role: "assistant", content: [{ type: "text", text: "The saved answer." }] },
    ],
  });
  await retry;
  await harness.advanceTime(450);
  assert.equal(harness.replyText(), "The saved answer.");
  assert.equal(harness.thinking(), false);
  assert.equal(harness.readOnly(), false);
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "other-run",
    state: "final",
    message: { role: "assistant", content: "unrelated" },
  });
  assert.equal(harness.replyText(), "The saved answer.");
  harness.setMessage("next turn");
  const next = harness.send(false);
  assert.equal(harness.sendCount(), 3);
  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "next-key" });
  await next;
  await harness.advanceTime(450);
  assert.equal(harness.readOnly(), true, "ordinary started ACK still waits for its final");
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "other-run",
    state: "final",
  });
  assert.equal(harness.readOnly(), true);
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "next-key",
    state: "final",
  });
  assert.equal(harness.readOnly(), false);
});

test("a buffered matching final wins over terminal history recovery", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.setMessage("answer");
  const sending = harness.send(false);
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "reply-key",
    state: "final",
    message: { role: "assistant", content: "Live final" },
  });
  harness.resolveSend({
    sessionKey: "global",
    agentId: "work",
    runId: "reply-key",
    status: "ok",
    recoveredMessages: [{ role: "assistant", content: "Recovered text" }],
  });
  await sending;
  await harness.advanceTime(450);
  assert.equal(harness.replyText(), "Live final");
  assert.equal(harness.readOnly(), false);
});

test("pre-ack frames replay once for only the acknowledged run", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.setMessage("hello");
  const sending = harness.send(false);
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "wrong-run",
    state: "delta",
    deltaText: "wrong",
  });
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "right-run",
    state: "delta",
    deltaText: "right",
  });
  assert.equal(harness.pendingCount(), 2);

  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "right-run" });
  await sending;

  assert.equal(harness.pendingCount(), 0);
  assert.equal(harness.activeRunId(), "right-run");
  assert.equal(harness.replyText(), "right");

  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: " right-run ",
    state: "delta",
    deltaText: " whitespace-id",
  });
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "other-agent",
    runId: "right-run",
    state: "delta",
    deltaText: " wrong-agent",
  });
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "right-run",
    state: "delta",
    deltaText: "!",
  });
  assert.equal(harness.replyText(), "right!");
});

test("final assistant canvas previews sync into isolated native webviews", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.setMessage("show status");
  const sending = harness.send(false);
  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "widget-run" });
  await sending;

  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "widget-run",
    state: "final",
    message: {
      role: "assistant",
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            sandbox: "strict",
            title: "Status",
            url: "/__openclaw__/canvas/documents/status/index.html",
          },
        },
      ],
    },
  });

  await harness.flushWidgets();
  const [layout] = harness.syncedWidgets();
  assert.deepEqual(
    { ...layout },
    {
      key: "/__openclaw__/canvas/documents/status/index.html",
      url: "https://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/status/index.html",
      sandbox: "strict",
      x: 52,
      y: 174,
      width: 540,
      height: 160,
      visible: true,
    },
  );
  assert.equal(harness.syncedHasWidgets(), true);
  assert.equal(harness.syncedExpanded(), true);
  assert.equal(harness.syncedGeneration(), 1);
});

test("expired Canvas capability refreshes before a new widget loads", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.expireCanvasSurface();
  harness.setMessage("show status");
  const sending = harness.send(false);
  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "refresh-run" });
  await sending;
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "refresh-run",
    state: "final",
    message: {
      role: "assistant",
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            sandbox: "scripts",
            url: "/__openclaw__/canvas/documents/status/index.html",
          },
        },
      ],
    },
  });

  await harness.flushSurfaceRefresh();
  await harness.flushWidgets();
  assert.equal(harness.widgetSurfaceRefreshCount(), 1);
  assert.equal(
    harness.syncedWidgets()[0]?.url,
    "https://gateway.example/__openclaw__/cap/refreshed-capability/__openclaw__/canvas/documents/status/index.html",
  );
});

test("transient Canvas refresh failures remain retryable", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.expireCanvasSurface();
  harness.setWidgetSurfaceRefreshFails(true);
  harness.setMessage("show status");
  const sending = harness.send(false);
  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "retry-run" });
  await sending;
  const widgetBlock = (id: string) => ({
    type: "canvas",
    preview: {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      sandbox: "scripts",
      url: `/__openclaw__/canvas/documents/${id}/index.html`,
    },
  });

  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "retry-run",
    state: "delta",
    message: { role: "assistant", content: [widgetBlock("first")] },
  });
  await harness.flushSurfaceRefresh();
  await harness.flushWidgets();
  assert.equal(harness.widgetSurfaceRefreshCount(), 1);
  assert.deepEqual([...harness.syncedWidgets()], []);

  harness.setWidgetSurfaceRefreshFails(false);
  harness.allowCanvasSurfaceRetry();
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "retry-run",
    state: "delta",
    message: { role: "assistant", content: [widgetBlock("second")] },
  });
  await harness.flushSurfaceRefresh();
  await harness.flushWidgets();
  assert.equal(harness.widgetSurfaceRefreshCount(), 2);
  assert.match(harness.syncedWidgets()[0]?.url ?? "", /refreshed-capability/u);
});

test("unchanged gateway state does not renew a failed Canvas capability", async () => {
  const harness = createQuickChatHarness();
  const surface = "https://gateway.example/__openclaw__/cap/fixture-capability";
  harness.setGatewayUp(surface);
  harness.expireCanvasSurface();
  harness.setWidgetSurfaceRefreshFails(true);
  harness.setMessage("show status");
  const sending = harness.send(false);
  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "state-run" });
  await sending;
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "state-run",
    state: "delta",
    message: {
      role: "assistant",
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            sandbox: "scripts",
            url: "/__openclaw__/canvas/documents/status/index.html",
          },
        },
      ],
    },
  });
  await harness.flushSurfaceRefresh();
  assert.equal(harness.widgetSurfaceRefreshCount(), 1);
  harness.emitGatewayState({ state: "up", canvasSurfaceUrl: surface, notice: "unchanged" });
  await harness.advanceTime(4_999);
  assert.equal(harness.widgetSurfaceRefreshCount(), 1);
  assert.equal(harness.syncedWidgets().length, 0);
  harness.setWidgetSurfaceRefreshFails(false);
  await harness.advanceTime(1);
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "state-run",
    state: "delta",
    message: {
      role: "assistant",
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            sandbox: "scripts",
            url: "/__openclaw__/canvas/documents/retry/index.html",
          },
        },
      ],
    },
  });
  await harness.flushSurfaceRefresh();
  assert.equal(harness.widgetSurfaceRefreshCount(), 2);
});

test("clearing the widget reply restores semantic text-only layout", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.setMessage("show status");
  const sending = harness.send(false);
  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "widget-run" });
  await sending;
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "widget-run",
    state: "delta",
    message: {
      role: "assistant",
      content: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            sandbox: "scripts",
            url: "/__openclaw__/canvas/documents/status/index.html",
          },
        },
      ],
    },
  });
  await harness.flushWidgets();
  assert.equal(harness.syncedHasWidgets(), true);

  harness.clearReply();
  await harness.flushWidgets();
  assert.equal(harness.syncedHasWidgets(), false);
  assert.equal(harness.syncedExpanded(), false);
  assert.deepEqual([...harness.syncedWidgets()], []);
});

test("adding a widget preserves the existing native webview identity", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.setMessage("show status");
  const sending = harness.send(false);
  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "widget-run" });
  await sending;
  const widgetBlock = (id: string) => ({
    type: "canvas",
    preview: {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      sandbox: "scripts",
      title: id,
      viewId: id,
      url: `/__openclaw__/canvas/documents/${id}/index.html`,
    },
  });

  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "widget-run",
    state: "delta",
    message: { role: "assistant", content: [widgetBlock("first")] },
  });
  await harness.flushWidgets();
  const firstLayout = { ...harness.syncedWidgets()[0] };
  const syncCountBeforeText = harness.widgetSyncCount();
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "widget-run",
    state: "delta",
    deltaText: "status update",
  });
  await harness.flushWidgets();
  assert.ok(harness.widgetSyncCount() > syncCountBeforeText);

  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "widget-run",
    state: "delta",
    message: { role: "assistant", content: [widgetBlock("first"), widgetBlock("second")] },
  });
  await harness.flushWidgets();
  const layouts = harness.syncedWidgets().map((layout: object) => Object.assign({}, layout));

  assert.deepEqual(layouts[0], firstLayout);
  assert.equal(layouts[0].visible, true);
  assert.equal(layouts[1].key, "second");
  assert.equal(layouts[1].visible, false);
});

test("hiding clears buffered pre-ack frames", async () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.setMessage("hello");
  const sending = harness.send(false);
  harness.handleChatEvent({
    sessionKey: "global",
    agentId: "work",
    runId: "right-run",
    state: "delta",
    deltaText: "buffered",
  });
  assert.equal(harness.pendingCount(), 1);

  await harness.requestHide();
  assert.equal(harness.pendingCount(), 0);
  harness.resolveSend({ sessionKey: "global", agentId: "work", runId: "right-run" });
  await sending;
  assert.equal(harness.replyText(), "");
});
