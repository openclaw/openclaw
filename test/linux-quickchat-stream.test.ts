import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it as test } from "vitest";

const quickchatSource = readFileSync(
  new URL("../apps/linux/ui/quickchat.js", import.meta.url),
  "utf8",
);
type Capability = { identifier?: string; windows?: string[]; webviews?: string[] };
const tauriConfig: { app?: { security?: { capabilities?: Capability[] } } } = JSON.parse(
  readFileSync(new URL("../apps/linux/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const browserBindingsStart = quickchatSource.indexOf("const tauri = window");
assert.notEqual(browserBindingsStart, -1, "quickchat pure-helper boundary");

type QuickChatHelpers = {
  chatMessageWidgets: (message: unknown) => Array<{
    key: string;
    title: string;
    target: string;
    preferredHeight: number;
    sandbox: string;
  }>;
  resolveInlineWidgetUrl: (surface: unknown, target: unknown) => string | null;
};

const { chatMessageWidgets, resolveInlineWidgetUrl }: QuickChatHelpers = vm.runInNewContext(
  `${quickchatSource.slice(0, browserBindingsStart)}\n({ chatMessageWidgets, resolveInlineWidgetUrl });`,
  { URL, TextEncoder },
);

function canvasBlock(url: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "canvas",
    preview: {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      sandbox: "scripts",
      url,
      ...overrides,
    },
  };
}

function canvasMessage(
  role: string,
  url: string,
  overrides: Record<string, unknown> = {},
  text?: string,
) {
  return {
    role,
    content: [...(text ? [{ type: "text", text }] : []), canvasBlock(url, overrides)],
  };
}

const documentUrl = (name: string) => `/__openclaw__/canvas/documents/${name}/index.html`;
const surfaceUrl = (name: string) => `https://gateway.example/__openclaw__/cap/${name}`;

function chatTarget(runId: string) {
  return { sessionKey: "global", agentId: "work", runId };
}

function chatEvent(runId: string, state: string, details: Record<string, unknown> = {}) {
  return { ...chatTarget(runId), state, ...details };
}

type Pending<T> = Pick<PromiseWithResolvers<T>, "resolve" | "reject">;
function pendingAt<T>(items: T[], index: number, kind: string) {
  const pending = items[index];
  assert.ok(pending, `${kind} invocation exists`);
  return pending;
}

function createFakeElement(tagName = "div") {
  const classes = new Set();
  const children: any[] = [];
  const styles = new Map<string, string>();
  const listeners = new Map<string, (event: unknown) => void>();
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
        classes[enabled ? "add" : "delete"](name);
        return enabled;
      },
    },
    style: {
      setProperty: (name: string, value: string) => void styles.set(name, value),
      removeProperty: (name: string) => void styles.delete(name),
      getPropertyValue: (name: string) => styles.get(name) ?? "",
    },
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    readOnly: false,
    scrollHeight: 0,
    scrollTop: 0,
    addEventListener(name: string, callback: (event: unknown) => void) {
      listeners.set(name, callback);
    },
    dispatchEvent: (event: { type: string }) => listeners.get(event.type)?.(event),
    append: (...nodes: any[]) => void children.push(...nodes),
    contains: () => false,
    focus() {},
    getBoundingClientRect: () => ({ x: 52, y: 174, width: 540, height: 160 }),
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
    replaceChildren: (...nodes: any[]) => void children.splice(0, children.length, ...nodes),
    setAttribute() {},
  };
}

function createQuickChatHarness(
  options: { initialize?: boolean; deferRegistration?: boolean; deferReady?: boolean } = {},
): Record<string, any> {
  const browserBindingsEnd = quickchatSource.indexOf("elements.input.addEventListener");
  assert.notEqual(browserBindingsEnd, -1, "quickchat browser binding boundary");
  const elements = new Map();
  const sends: Pending<unknown>[] = [];
  const calls: Array<{ method: string; args: Record<string, any> }> = [];
  const nativeListeners = new Map<string, (event: unknown) => void>();
  const documentListeners = new Map<string, (event: unknown) => void>();
  const registration = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<boolean>();
  let nativeReady = !options.initialize;
  let nativeVisible = true;
  const refreshes: Pending<unknown>[] = [];
  let deferRefresh = false;
  const widgetSyncs: Array<Pending<void> & { args: Record<string, unknown> }> = [];
  let deferWidgetSync = false;
  let activeWidgetSyncs = 0;
  let maxActiveWidgetSyncs = 0;
  const windowListeners = new Map<string, () => void>();
  let syncedWidgets: unknown[] = [];
  let syncedExpanded = false;
  let widgetSyncCount = 0;
  let widgetSurfaceRefreshCount = 0;
  let widgetSurfaceRefreshFails = false;
  const widgetSurfaceRefreshResult = surfaceUrl("refreshed-capability");
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
            expanded?: boolean;
            gatewayGeneration?: number;
          },
        ) {
          calls.push({ method, args: args ?? {} });
          if (method === "quickchat_ready") {
            return (options.deferReady ? ready.promise : Promise.resolve(true)).then((show) => {
              nativeReady = true;
              return show;
            });
          }
          if (method === "quickchat_activate" || method === "quickchat_hide") {
            if (nativeReady) {
              nativeVisible = method === "quickchat_activate";
            }
            return Promise.resolve(nativeReady);
          }
          if (method === "quickchat_send") {
            return new Promise((resolve, reject) => {
              sends.push({ resolve, reject });
            });
          }
          if (method === "quickchat_refresh_widget_surface") {
            widgetSurfaceRefreshCount += 1;
            if (deferRefresh) {
              return new Promise((resolve, reject) => {
                refreshes.push({ resolve, reject });
              });
            }
            return widgetSurfaceRefreshFails
              ? Promise.reject(new Error("refresh failed"))
              : Promise.resolve({
                  gatewayGeneration: args?.gatewayGeneration ?? 1,
                  canvasSurfaceUrl: widgetSurfaceRefreshResult,
                });
          }
          if (method === "quickchat_sync_widgets") {
            syncedWidgets = args?.widgets ?? [];
            syncedExpanded = args?.expanded === true;
            widgetSyncCount += 1;
            if (deferWidgetSync) {
              activeWidgetSyncs += 1;
              maxActiveWidgetSyncs = Math.max(maxActiveWidgetSyncs, activeWidgetSyncs);
              return new Promise<void>((resolve, reject) => {
                widgetSyncs.push({ args: structuredClone(args ?? {}), resolve, reject });
              }).finally(() => {
                activeWidgetSyncs -= 1;
              });
            }
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
      event: {
        listen: async (name: string, callback: (event: unknown) => void) => {
          nativeListeners.set(name, callback);
          if (name === "quickchat:shown" && options.deferRegistration) {
            await registration.promise;
          }
          return () => nativeListeners.delete(name);
        },
      },
    },
    addEventListener(name: string, callback: () => void) {
      windowListeners.set(name, callback);
    },
    clearTimeout: (id: number) => void timers.delete(id),
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame(callback: () => void) {
      const id = ++timerId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => void frames.delete(id),
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
    addEventListener(name: string, callback: (event: unknown) => void) {
      documentListeners.set(name, callback);
    },
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
  const initialized = vm.runInNewContext(
    `${options.initialize ? "(async () => {" : ""}
${quickchatSource.slice(0, browserBindingsEnd)}
this.harness = {
  send,
  prepareSend(payload) { prepareChatSend({gatewayGeneration: 1, ...payload}); },
  handleChatEvent(payload) { handleChatEvent({gatewayGeneration: 1, ...payload}); },
  requestHide,
  clearReply,
  toggleReply,
  setGatewayUp(surface = "https://gateway.example/__openclaw__/cap/fixture-capability", gatewayGeneration = 1) {
    setGatewayState({state: "up", canvasSurfaceUrl: surface, gatewayGeneration});
    if (visibilitySequence === 0) reveal();
  },
  advanceTime(ms) { return advanceTime(ms); },
  emitGatewayState(payload) { setGatewayState({gatewayGeneration: 1, ...payload}); },
  accent() { return document.documentElement.style.getPropertyValue("--accent"); },
  setMessage(value) { elements.input.value = value; updateSendButton(); },
  pendingCount() { return pendingChatEvents.length; },
  activeRunId() { return activeReply?.runId ?? null; },
  replyText() { return elements.replyText.textContent; },
  replyError() { return elements.replyError.textContent; },
  readOnly() { return elements.input.readOnly; },
  sendDisabled() { return elements.send.disabled; },
  replyVisible() { return !elements.reply.hidden; },
  thinking() { return !elements.replyThinking.hidden; },
  draft() { return elements.input.value; },
  error() { return elements.status.textContent; },
  reveal,
  expireCanvasSurface() { canvasSurfaceRefreshedAt = 0; canvasSurfaceRetryAt = 0; },
  flushSurfaceRefresh() { return canvasSurfaceRefreshPromise ?? Promise.resolve(); },
  flushWidgets() { return widgetSyncPromise; },
};
${options.initialize ? `${quickchatSource.slice(browserBindingsEnd)}\n})()` : ""}`,
    browserContext,
  );
  return {
    ...(browserContext.harness as Record<string, (...args: any[]) => any>),
    resolveSend: (value: Record<string, unknown>, index = sends.length - 1) => {
      pendingAt(sends, index, "send").resolve({
        gatewayGeneration: 1,
        status: "started",
        ...value,
      });
    },
    rejectSend: (message: string, index = sends.length - 1) => {
      pendingAt(sends, index, "send").reject(new Error(message));
    },
    event: (runId: string, state: string, details: Record<string, unknown> = {}) =>
      browserContext.harness.handleChatEvent(chatEvent(runId, state, details)),
    sendCount: () => sends.length,
    calls,
    callsFor: (method: string) => calls.filter((call) => call.method === method),
    visibilityCalls: () =>
      calls
        .filter(({ method }) => ["quickchat_activate", "quickchat_hide"].includes(method))
        .map(({ method, args }) => [method, args.generation]),
    drain,
    initialized: () => initialized,
    releaseRegistration: () => registration.resolve(),
    rejectRegistration: () => registration.reject(new Error("Native registration failed.")),
    resolveReady: (show = true) => ready.resolve(show),
    rejectReady: () => ready.reject(new Error("Native admission failed.")),
    nativeVisible: () => nativeVisible,
    emitNative: (name: string) => {
      const listener = nativeListeners.get(name);
      assert.ok(listener, `native ${name} listener registered`);
      listener({});
    },
    pressEscape: () => {
      let stopped = false;
      const event = {
        type: "keydown",
        key: "Escape",
        keyCode: 27,
        defaultPrevented: false,
        isComposing: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          stopped = true;
        },
      };
      documentListeners.get("keydown")?.(event);
      if (!stopped) {
        elements.get("#message").dispatchEvent(event);
      }
    },
    flushWidgets: async () => {
      await drain();
      await browserContext.harness.flushWidgets();
      await drain();
    },
    deferRefresh: () => {
      deferRefresh = true;
    },
    resolveRefresh: (value: unknown, index = refreshes.length - 1) => {
      pendingAt(refreshes, index, "refresh").resolve(value);
    },
    rejectRefresh: (index = refreshes.length - 1) => {
      pendingAt(refreshes, index, "refresh").reject(new Error("stale refresh failed"));
    },
    syncedWidgets: () => syncedWidgets,
    syncedExpanded: () => syncedExpanded,
    widgetSyncCount: () => widgetSyncCount,
    deferWidgetSync: () => {
      deferWidgetSync = true;
    },
    widgetSyncs: () => widgetSyncs.map(({ args }) => args),
    activeWidgetSyncs: () => activeWidgetSyncs,
    maxActiveWidgetSyncs: () => maxActiveWidgetSyncs,
    resolveWidgetSync: (index: number) => {
      pendingAt(widgetSyncs, index, "widget sync").resolve();
    },
    rejectWidgetSync: (index: number) => {
      pendingAt(widgetSyncs, index, "widget sync").reject(new Error("widget sync failed"));
    },
    resizeWidget: (x: number) => {
      const host = elements.get("#reply-widgets")?.querySelector(".inline-widget-host");
      assert.ok(host, "rendered widget host exists");
      host.getBoundingClientRect = () => ({ x, y: 174, width: 540, height: 160 });
      const resize = windowListeners.get("resize");
      assert.ok(resize, "renderer registered its resize handler");
      resize();
    },
    widgetSurfaceRefreshCount: () => widgetSurfaceRefreshCount,
    setWidgetSurfaceRefreshFails: (value: boolean) => {
      widgetSurfaceRefreshFails = value;
    },
  };
}

function expectState(
  harness: ReturnType<typeof createQuickChatHarness>,
  expected: Record<string, unknown>,
) {
  const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, harness[key]()]));
  expect(actual).toMatchObject(expected);
}

function readyHarness(message: string) {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();
  harness.setMessage(message);
  return harness;
}

async function acknowledge(
  harness: ReturnType<typeof createQuickChatHarness>,
  runId: string,
  gatewayGeneration = 1,
) {
  const sending = harness.send(false);
  harness.resolveSend({ ...chatTarget(runId), gatewayGeneration });
  await sending;
}

const pausedStartup = { initialize: true, deferRegistration: true, deferReady: true };

for (const fireBeforeReady of [false, true]) {
  test(`startup preserves Escape when its timer fires ${fireBeforeReady ? "before" : "after"} native admission`, async () => {
    const harness = createQuickChatHarness(pausedStartup);
    harness.pressEscape();
    if (fireBeforeReady) {
      await harness.advanceTime(45);
    }
    harness.releaseRegistration();
    await harness.drain();
    assert.ok(harness.callsFor("quickchat_ready").length > 0);
    harness.resolveReady();
    await harness.initialized();
    await harness.advanceTime(45);
    assert.equal(harness.nativeVisible(), false, `early timer=${fireBeforeReady}`);
    assert.deepEqual(harness.visibilityCalls(), [["quickchat_hide", 1]]);
  });
}

for (const showLast of [false, true]) {
  test(`native admission applies only the latest queued ${showLast ? "show" : "hide"} intent`, async () => {
    const harness = createQuickChatHarness({ initialize: true, deferReady: true });
    await harness.drain();
    harness.emitNative("quickchat:shown");
    harness.emitNative("quickchat:hide-requested");
    await harness.advanceTime(45);
    if (showLast) {
      harness.emitNative("quickchat:shown");
    }
    harness.resolveReady();
    await harness.initialized();
    await harness.drain();
    assert.equal(harness.nativeVisible(), showLast);
    assert.deepEqual(harness.visibilityCalls(), [
      [showLast ? "quickchat_activate" : "quickchat_hide", showLast ? 3 : 2],
    ]);
  });
}

for (const failedStage of ["registration", "admission"] as const) {
  test(`startup ${failedStage} failure settles queued visibility without bypassing native checks`, async () => {
    const harness = createQuickChatHarness(pausedStartup);
    harness.pressEscape();
    await harness.advanceTime(45);
    if (failedStage === "registration") {
      harness.rejectRegistration();
    } else {
      harness.releaseRegistration();
      await harness.drain();
      harness.rejectReady();
    }
    await harness.initialized();
    await harness.drain();
    expectState(harness, { nativeVisible: true, error: "Gateway unreachable — retrying" });
    assert.equal(harness.callsFor("quickchat_hide").length, 0);

    harness.pressEscape();
    await harness.advanceTime(45);
    assert.equal(harness.callsFor("quickchat_hide").length, 1);
    assert.equal(harness.nativeVisible(), true);
  });
}

test("gateway state updates and clears the Quick Chat user accent", () => {
  const harness = createQuickChatHarness();
  harness.setGatewayUp();

  for (const accent of ["#45b6fe", "#52c99a", ""]) {
    harness.emitGatewayState({ state: "up", ...(accent ? { accent } : {}) });
    assert.equal(harness.accent(), accent);
  }
});

test("widget child webviews inherit no Quick Chat Tauri capability", () => {
  const capability = tauriConfig.app?.security?.capabilities?.find(
    (candidate) => candidate.identifier === "quickchat",
  );

  assert.deepEqual(capability?.webviews, ["quickchat"]);
  assert.equal(capability?.windows, undefined);
});

test("canvas previews are accepted only for safe assistant widgets", () => {
  const [widget] = chatMessageWidgets(
    canvasMessage("assistant", documentUrl("build-status"), {
      title: "Build status",
      preferredHeight: 2_000,
      viewId: "build-status",
    }),
  );

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
    content: ["first", "second", "third"].map((name, index) =>
      canvasBlock(`/__openclaw__/canvas/documents/${name}/index.html`, {
        viewId: index === 2 ? "duplicate-2" : "duplicate",
      }),
    ),
  });
  expect(duplicateWidgets.map(({ key }) => key)).toEqual([
    "duplicate",
    "duplicate-2",
    "duplicate-2-2",
  ]);
  for (const [name, viewId] of [
    ["emoji", "🦞".repeat(65)],
    ["cjk", "界".repeat(201)],
  ] as const) {
    const [bounded] = chatMessageWidgets(canvasMessage("assistant", documentUrl(name), { viewId }));
    assert.notEqual(bounded?.key, viewId);
    assert.ok(Buffer.byteLength(bounded?.key ?? "", "utf8") <= 256);
  }
  for (const message of [
    canvasMessage("tool", documentUrl("tool")),
    { content: [canvasBlock(documentUrl("roleless"))] },
    canvasMessage("assistant", "/__openclaw__/canvas/documents/%252e%252e/private-file"),
  ]) {
    assert.equal(chatMessageWidgets(message).length, 0);
  }
});

test("widget URLs stay inside the capability-scoped Canvas host", () => {
  const target = documentUrl("widget-1");
  const surface = "https://gateway.example/base/__openclaw__/cap/fixture-capability";
  assert.equal(
    resolveInlineWidgetUrl(surface, `${target}?mode=compact#result`),
    "https://gateway.example/base/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/widget-1/index.html?mode=compact#result",
  );
  for (const host of ["localhost", "[::1]"]) {
    const loopback = `http://${host}:18789/__openclaw__/cap/fixture-capability`;
    assert.equal(resolveInlineWidgetUrl(loopback, target), `${loopback}${target}`);
  }
  for (const [base, document] of [
    ["http://gateway.example/__openclaw__/cap/fixture-capability", target],
    [`${surface}?leak=1`, target],
    ["https://gateway.example/base/__openclaw__/cap/%252f..%252fother", target],
    [surface, "https://evil.example/widget.html"],
  ]) {
    assert.equal(resolveInlineWidgetUrl(base, document), null);
  }
});

test("a cached terminal retry presents the recovered reply and unlocks without another event", async () => {
  const harness = readyHarness("recover my reply");
  const first = harness.send(false);
  harness.rejectSend("ACK connection closed");
  await first;
  assert.equal(harness.draft(), "recover my reply");
  harness.emitGatewayState({ state: "down" });
  await harness.drain();
  harness.setGatewayUp();
  const retry = harness.send(false);
  harness.resolveSend({
    ...chatTarget("retained-key"),
    status: "ok",
    recoveredMessages: [
      { role: "assistant", content: [{ type: "text", text: "The saved answer." }] },
    ],
  });
  await retry;
  await harness.advanceTime(450);
  expectState(harness, { replyText: "The saved answer.", thinking: false, readOnly: false });
  harness.event("other-run", "final", {
    message: { role: "assistant", content: "unrelated" },
  });
  assert.equal(harness.replyText(), "The saved answer.");
  harness.setMessage("next turn");
  const next = harness.send(false);
  assert.equal(harness.sendCount(), 3);
  harness.resolveSend(chatTarget("next-key"));
  await next;
  await harness.advanceTime(450);
  assert.equal(harness.readOnly(), false, "the next draft stays editable during the reply");
  harness.setMessage("A prepared follow-up");
  assert.equal(harness.sendDisabled(), true);
  await harness.send(false);
  assert.equal(harness.sendCount(), 3, "ordinary started ACK still waits for its final");
  harness.event("other-run", "final");
  assert.equal(harness.sendDisabled(), true);
  harness.event("next-key", "final");
  expectState(harness, { readOnly: false, sendDisabled: false, draft: "A prepared follow-up" });
});

test("a buffered matching final wins over terminal history recovery", async () => {
  const harness = readyHarness("answer");
  const sending = harness.send(false);
  harness.event("reply-key", "status", {
    status: { phase: "starting_model" },
  });
  harness.event("reply-key", "final", {
    message: { role: "assistant", content: "Live final" },
  });
  harness.resolveSend({
    ...chatTarget("reply-key"),
    status: "ok",
    recoveredMessages: [{ role: "assistant", content: "Recovered text" }],
  });
  await sending;
  await harness.advanceTime(450);
  expectState(harness, { replyText: "Live final", readOnly: false });
});

test("collapse preserves live replies, drafts, and widget instances and wins a delayed acknowledgement", async () => {
  const harness = readyHarness("Show the current status");
  const target = chatTarget("first-run");
  await acknowledge(harness, target.runId);
  await harness.advanceTime(450);
  harness.handleChatEvent({
    ...target,
    state: "delta",
    message: canvasMessage("assistant", documentUrl("status"), {}, "Checking the project."),
  });
  await harness.drain();
  const widget = { ...harness.syncedWidgets()[0] };
  assert.equal(widget.visible, true);
  harness.setMessage("Keep this\nnext draft.");
  harness.toggleReply();
  await harness.drain();
  expectState(harness, { replyVisible: false, syncedExpanded: false });
  assert.deepEqual({ ...harness.syncedWidgets()[0] }, { ...widget, visible: false });
  assert.equal(harness.draft(), "Keep this\nnext draft.");
  harness.handleChatEvent({ ...target, state: "delta", deltaText: " Still working." });
  await harness.drain();
  assert.equal(harness.replyVisible(), false);
  harness.toggleReply();
  await harness.drain();
  expectState(harness, {
    replyVisible: true,
    replyText: "Checking the project. Still working.",
    draft: "Keep this\nnext draft.",
  });
  assert.deepEqual({ ...harness.syncedWidgets()[0] }, widget);
  assert.equal(harness.sendCount(), 1);

  harness.handleChatEvent({ ...target, state: "final" });
  const next = harness.send(false);
  harness.toggleReply();
  const followup = { ...target, runId: "follow-up-run" };
  harness.handleChatEvent({
    ...followup,
    state: "delta",
    message: { role: "assistant", content: "A new reply." },
  });
  harness.resolveSend(followup);
  await next;
  await harness.drain();
  assert.equal(harness.replyVisible(), false, "the acknowledgement cannot undo a newer collapse");
  expectState(harness, { replyText: "A new reply.", draft: "" });
});

function widgetFinal(gatewayGeneration = 1, document = "owner-a") {
  return {
    gatewayGeneration,
    ...chatTarget("widget-owner-run"),
    state: "final",
    message: canvasMessage("assistant", documentUrl(document), { sandbox: "strict" }),
  };
}

function updateWidgetKeys(harness: Record<string, any>, keys: string[]) {
  harness.event("widget-owner-run", "delta", {
    message: {
      role: "assistant",
      content: keys.map((viewId) =>
        canvasBlock(documentUrl(viewId), { sandbox: "strict", viewId }),
      ),
    },
  });
}

async function settleWidgetSync(
  harness: ReturnType<typeof createQuickChatHarness>,
  index = 0,
  reject = false,
) {
  harness[reject ? "rejectWidgetSync" : "resolveWidgetSync"](index);
  await harness.drain();
  return harness.widgetSyncs()[index + 1];
}

async function finishWidgetSync(harness: ReturnType<typeof createQuickChatHarness>) {
  await settleWidgetSync(harness, 1);
  assert.equal(harness.widgetSyncs().length, 2);
}

async function createSlowWidgetHarness() {
  const harness = readyHarness("show widgets");
  await acknowledge(harness, "widget-owner-run");
  await harness.flushWidgets();
  harness.deferWidgetSync();
  updateWidgetKeys(harness, ["first"]);
  await harness.drain();
  assert.equal(harness.widgetSyncs().length, 1);
  return harness;
}

for (const kind of ["geometry", "structure"] as const) {
  test(`widget sync coalesces six ${kind} frames into initial and latest state`, async () => {
    const harness = await createSlowWidgetHarness();
    // Six distinct RAF batches including the initial in-flight state.
    for (let frame = 1; frame <= 5; frame += 1) {
      if (kind === "structure") {
        updateWidgetKeys(harness, frame === 2 ? [] : [`widget-${frame}`]);
      }
      if (kind === "geometry" || frame !== 2) {
        harness.resizeWidget(52 + frame);
      }
      await harness.drain();
    }
    assert.equal(harness.widgetSyncs().length, 1);
    assert.equal(harness.activeWidgetSyncs(), 1);
    harness.resolveWidgetSync(0);
    await harness.drain();
    const latest = harness.widgetSyncs()[1];
    assert.equal(latest.widgets[0].x, 57);
    assert.equal(latest.widgets[0].key, kind === "geometry" ? "first" : "widget-5");
    assert.equal(latest.hasWidgets, true);
    assert.equal(latest.expanded, true);
    assert.equal(latest.sessionId, harness.widgetSyncs()[0].sessionId);
    assert.equal(latest.rendererEpoch, harness.widgetSyncs()[0].rendererEpoch);
    harness.resolveWidgetSync(1);
    await harness.drain();
    assert.equal(harness.widgetSyncs().length, 2);
    assert.equal(harness.activeWidgetSyncs(), 0);
    assert.equal(harness.maxActiveWidgetSyncs(), 1);
  });
}

test("widget sync retains a latest empty compact state", async () => {
  const harness = await createSlowWidgetHarness();
  harness.resizeWidget(56);
  await harness.drain();
  harness.clearReply();
  await harness.drain();
  const latest = await settleWidgetSync(harness);
  expect(latest).toMatchObject({ widgets: [], hasWidgets: false, expanded: false });
  await finishWidgetSync(harness);
});

test("widget sync allows a newer reply to supersede a pending clear", async () => {
  const harness = await createSlowWidgetHarness();
  harness.handleChatEvent({ ...widgetFinal(), message: { role: "assistant", content: [] } });
  await harness.advanceTime(450);
  harness.setMessage("new reply");
  const sending = harness.send(false);
  await harness.drain();
  harness.resolveSend(chatTarget("new-run"));
  await sending;
  harness.handleChatEvent({ ...widgetFinal(), runId: "new-run" });
  await harness.drain();
  const latest = await settleWidgetSync(harness);
  expect(latest.widgets).toMatchObject([{ url: expect.stringMatching(/documents\/owner-a/u) }]);
  await finishWidgetSync(harness);
});

for (const transition of ["hide", "reveal"] as const) {
  test(`widget sync drops pending pre-${transition} visibility state`, async () => {
    const harness = await createSlowWidgetHarness();
    harness.resizeWidget(56);
    await harness.drain();
    await harness.requestHide();
    if (transition === "hide") {
      await harness.advanceTime(45);
      assert.ok(harness.callsFor("quickchat_hide").length > 0);
    } else {
      harness.reveal();
      await harness.drain();
    }
    const latest = await settleWidgetSync(harness);
    assert.equal(latest.generation, transition === "hide" ? 2 : 3);
    assert.equal(latest.widgets.length, transition === "hide" ? 0 : 1);
    await finishWidgetSync(harness);
  });
}

for (const transition of ["owner", "surface"] as const) {
  test(`widget sync preserves ${transition} fencing while work is pending`, async () => {
    const harness = await createSlowWidgetHarness();
    harness.resizeWidget(56);
    await harness.drain();
    const originalSurface = harness.widgetSyncs()[0].surfaceUrl;
    if (transition === "owner") {
      harness.setGatewayUp(surfaceUrl("other"), 2);
      await harness.drain();
      harness.setGatewayUp(originalSurface, 3);
    } else {
      harness.emitGatewayState({ state: "down" });
      await harness.drain();
      harness.setGatewayUp(surfaceUrl("rotated"), 1);
    }
    await harness.drain();
    const latest = await settleWidgetSync(harness, 0, true);
    assert.equal(latest.gatewayGeneration, transition === "owner" ? 3 : 1);
    assert.equal(latest.widgets.length, transition === "owner" ? 0 : 1);
    if (transition === "surface") {
      assert.match(latest.widgets[0].url, /\/cap\/rotated\//u);
    }
    assert.equal(harness.error(), "");
    await finishWidgetSync(harness);
  });
}

test("widget sync drains the latest state after rejection without replaying the failure", async () => {
  const harness = await createSlowWidgetHarness();
  for (const x of [54, 57]) {
    harness.resizeWidget(x);
    await harness.drain();
  }
  const latest = await settleWidgetSync(harness, 0, true);
  assert.equal(latest.widgets[0].x, 57);
  assert.equal(harness.error(), "", "a superseded sync must not overwrite current status");
  await finishWidgetSync(harness);
  assert.equal(harness.maxActiveWidgetSyncs(), 1);
});

test("widget sync reports a current failure once and accepts later work", async () => {
  const harness = await createSlowWidgetHarness();
  await settleWidgetSync(harness, 0, true);
  assert.equal(harness.error(), "widget sync failed");
  assert.equal(harness.widgetSyncs().length, 1, "failure does not retry itself");
  harness.resizeWidget(57);
  await harness.drain();
  assert.equal(harness.widgetSyncs()[1].widgets[0].x, 57);
  await settleWidgetSync(harness, 1);
  assert.equal(harness.activeWidgetSyncs(), 0);
});

for (const timing of ["same-frame", "awaiting-frame"] as const) {
  test(`widget sync uses the latest ${timing} bounds`, async () => {
    const harness = await createSlowWidgetHarness();
    harness.resizeWidget(54);
    if (timing === "awaiting-frame") {
      await harness.drain();
    }
    harness.resizeWidget(57);
    if (timing === "same-frame") {
      await harness.drain();
    }
    const latest = await settleWidgetSync(harness);
    assert.equal(latest.widgets[0].x, 57);
    await finishWidgetSync(harness);
  });
}

test("retained widgets reconnect only to their original generation, including same-URL roundtrips", async () => {
  const harness = createQuickChatHarness();
  const surfaceA = surfaceUrl("owner-a");
  harness.setGatewayUp(surfaceA, 1);
  harness.setMessage("widget");
  await acknowledge(harness, "widget-owner-run");
  harness.handleChatEvent(widgetFinal());
  await harness.flushWidgets();
  assert.ok(harness.syncedWidgets()[0]?.url.includes("/cap/owner-a/"));
  harness.emitGatewayState({ state: "down" });
  await harness.flushWidgets();
  assert.equal(harness.syncedWidgets().length, 0);
  harness.setGatewayUp(surfaceUrl("owner-a-rotated"), 1);
  await harness.flushWidgets();
  assert.ok(harness.syncedWidgets()[0]?.url.includes("/cap/owner-a-rotated/"));
  const switchedAt = harness.calls.length;
  harness.emitGatewayState({ state: "down", gatewayGeneration: 2 });
  await harness.flushWidgets();
  harness.setGatewayUp(surfaceUrl("owner-b"), 2);
  await harness.flushWidgets();
  harness.setGatewayUp(surfaceA, 3);
  await harness.flushWidgets();
  const laterLayouts = harness.calls
    .slice(switchedAt)
    .filter((call: { method: string }) => call.method === "quickchat_sync_widgets")
    .flatMap((call: { args: { widgets: unknown[] } }) => call.args.widgets);
  assert.equal(laterLayouts.length, 0);
});

for (const outcome of ["success", "failure"] as const) {
  test(`a stale Canvas refresh ${outcome} cannot settle the new owner's refresh`, async () => {
    const harness = createQuickChatHarness();
    harness.deferRefresh();
    harness.setGatewayUp();
    harness.expireCanvasSurface();
    harness.setMessage("A widget");
    await acknowledge(harness, "widget-owner-run");
    harness.handleChatEvent(widgetFinal());
    await harness.advanceTime(450);
    assert.equal(harness.widgetSurfaceRefreshCount(), 1);
    harness.emitGatewayState({ state: "down", gatewayGeneration: 2 });
    await harness.drain();
    harness.setGatewayUp(surfaceUrl("owner-b"), 2);
    harness.expireCanvasSurface();
    harness.setMessage("B widget");
    await acknowledge(harness, "widget-owner-run", 2);
    harness.handleChatEvent(widgetFinal(2, "owner-b"));
    await harness.drain();
    assert.equal(harness.widgetSurfaceRefreshCount(), 2);
    if (outcome === "success") {
      harness.resolveRefresh(
        {
          gatewayGeneration: 1,
          canvasSurfaceUrl: surfaceUrl("stale-a"),
        },
        0,
      );
    } else {
      harness.rejectRefresh(0);
    }
    await harness.advanceTime(0);
    assert.equal(harness.widgetSurfaceRefreshCount(), 2);
    harness.resolveRefresh(
      {
        gatewayGeneration: 2,
        canvasSurfaceUrl: surfaceUrl("fresh-b"),
      },
      1,
    );
    await harness.flushSurfaceRefresh();
    await harness.flushWidgets();
    assert.equal(harness.syncedWidgets().length, 1);
    assert.match(harness.syncedWidgets()[0].url, /fresh-b.*documents\/owner-b/u);
  });
}

test("prepared request keeps its pre-ack text and widgets across more than 64 foreign runs", async () => {
  const harness = readyHarness("hello");
  const sending = harness.send(false);
  harness.prepareSend(chatTarget("right-run"));
  const foreignRuns = () => {
    for (let index = 0; index < 65; index += 1) {
      harness.event(`foreign-${index}`, "delta", {
        deltaText: "foreign",
        message: { role: "assistant", content: "foreign" },
      });
    }
  };
  foreignRuns();
  harness.event("right-run", "status", {
    status: { phase: "starting_model" },
  });
  harness.event("wrong-run", "delta", {
    deltaText: "wrong",
    message: { role: "assistant", content: "wrong" },
  });
  harness.event("right-run", "delta", {
    deltaText: "right",
    message: canvasMessage("assistant", documentUrl("status"), {}, "right"),
  });
  foreignRuns();
  for (let index = 0; index < 64; index += 1) {
    harness.event("right-run", "delta", {
      deltaText: "x",
    });
  }
  assert.ok(harness.pendingCount() <= 64);

  harness.resolveSend(chatTarget("right-run"));
  await sending;
  await harness.drain();

  expectState(harness, {
    pendingCount: 0,
    activeRunId: "right-run",
    replyText: `right${"x".repeat(64)}`,
  });
  assert.equal(harness.syncedWidgets().length, 1);

  harness.event(" right-run ", "delta", {
    deltaText: " whitespace-id",
  });
  harness.event("right-run", "delta", {
    agentId: "other-agent",
    deltaText: " wrong-agent",
  });
  harness.event("right-run", "delta", {
    deltaText: "!",
  });
  assert.equal(harness.replyText(), `right${"x".repeat(64)}!`);
});

for (const outcome of ["retained", "evicted", "repaired", "recovered"] as const) {
  test(`a retry prefix received before preparation is ${outcome} explicitly`, async () => {
    const harness = readyHarness("retry my reply");
    const sending = harness.send(false);
    const target = chatTarget("retry-run");
    harness.event(target.runId, "delta", {
      deltaText: "prefix",
      message: { role: "assistant", content: "prefix" },
    });
    if (outcome !== "retained") {
      for (let index = 0; index < 65; index += 1) {
        harness.event(`other-${index}`, "delta", {
          deltaText: "foreign",
          message: { role: "assistant", content: "foreign" },
        });
      }
    }
    harness.handleChatEvent({ ...target, state: "delta", deltaText: " suffix" });
    harness.prepareSend(target);
    harness.handleChatEvent({ ...target, state: "delta", deltaText: " more" });
    harness.event(
      target.runId,
      "final",
      outcome === "repaired"
        ? { message: { role: "assistant", content: "prefix suffix more" } }
        : {},
    );
    harness.resolveSend({
      ...target,
      ...(outcome === "recovered"
        ? {
            status: "ok",
            recoveredMessages: [{ role: "assistant", content: "prefix suffix more" }],
          }
        : {}),
    });
    await sending;
    await harness.advanceTime(450);
    expectState(harness, {
      replyText: outcome === "evicted" ? "" : "prefix suffix more",
      replyError:
        outcome === "evicted" ? "Reply text is incomplete. Open the dashboard to recover it." : "",
      readOnly: false,
      pendingCount: 0,
    });
  });
}

test("unchanged gateway state does not renew a failed Canvas capability", async () => {
  const harness = createQuickChatHarness();
  const surface = surfaceUrl("fixture-capability");
  harness.setGatewayUp(surface);
  harness.expireCanvasSurface();
  harness.setWidgetSurfaceRefreshFails(true);
  harness.setMessage("show status");
  await acknowledge(harness, "state-run");
  harness.event("state-run", "delta", {
    message: canvasMessage("assistant", documentUrl("status")),
  });
  await harness.flushSurfaceRefresh();
  assert.equal(harness.widgetSurfaceRefreshCount(), 1);
  harness.emitGatewayState({ state: "up", canvasSurfaceUrl: surface, notice: "unchanged" });
  await harness.advanceTime(4_999);
  assert.equal(harness.widgetSurfaceRefreshCount(), 1);
  assert.equal(harness.syncedWidgets().length, 0);
  harness.setWidgetSurfaceRefreshFails(false);
  await harness.advanceTime(1);
  harness.event("state-run", "delta", {
    message: canvasMessage("assistant", documentUrl("retry")),
  });
  await harness.flushSurfaceRefresh();
  assert.equal(harness.widgetSurfaceRefreshCount(), 2);
});

test("adding a widget preserves the existing native webview identity", async () => {
  const harness = readyHarness("show status");
  await acknowledge(harness, "widget-run");
  const widgetBlock = (id: string) =>
    canvasBlock(`/__openclaw__/canvas/documents/${id}/index.html`, { title: id, viewId: id });

  harness.event("widget-run", "delta", {
    message: { role: "assistant", content: [widgetBlock("first")] },
  });
  await harness.flushWidgets();
  const firstLayout = { ...harness.syncedWidgets()[0] };
  const syncCountBeforeText = harness.widgetSyncCount();
  harness.event("widget-run", "delta", {
    deltaText: "status update",
  });
  await harness.flushWidgets();
  assert.ok(harness.widgetSyncCount() > syncCountBeforeText);

  harness.event("widget-run", "delta", {
    message: { role: "assistant", content: [widgetBlock("first"), widgetBlock("second")] },
  });
  await harness.flushWidgets();
  const layouts = harness.syncedWidgets().map((layout: object) => Object.assign({}, layout));

  assert.deepEqual(layouts[0], firstLayout);
  expect(layouts).toMatchObject([{ visible: true }, { key: "second", visible: false }]);
});

test("hiding clears buffered pre-ack frames", async () => {
  const harness = readyHarness("hello");
  const sending = harness.send(false);
  harness.event("right-run", "delta", {
    deltaText: "buffered",
  });
  assert.equal(harness.pendingCount(), 1);

  await harness.requestHide();
  assert.equal(harness.pendingCount(), 0);
  harness.resolveSend(chatTarget("right-run"));
  await sending;
  assert.equal(harness.replyText(), "");
});
