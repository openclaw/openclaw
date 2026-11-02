/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import {
  hasNativeBrowserBridge,
  postNativeBrowserMessage,
  readNativeBrowserState,
  subscribeNativeBrowserState,
  type NativeBrowserMessage,
} from "./native-browser-bridge.ts";

const tab = {
  id: "mac-1",
  sessionKey: "agent:main:first",
  url: "https://example.com/",
  title: "Example",
  loading: false,
  canGoBack: false,
  canGoForward: true,
  openedBy: "web",
};
function install(postMessage = vi.fn().mockResolvedValue({ ok: true })) {
  vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage } } });
  return postMessage;
}
function push(detail: unknown) {
  window.dispatchEvent(new CustomEvent("openclaw:native-browser-state", { detail }));
}
function send(type: "close" | "download" | "snapshot" | "reload") {
  return postNativeBrowserMessage({ type, tabId: "mac-1" });
}
const snapshotReply = {
  ok: true,
  dataUrl: "data:image/png;base64,eA==",
  cssWidth: 640,
  cssHeight: 480,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("is inert outside the native host", async () => {
  const listener = vi.fn();
  expect(hasNativeBrowserBridge()).toBe(false);
  expect(readNativeBrowserState()).toBeNull();
  expect(await send("close")).toBeNull();
  const unsubscribe = subscribeNativeBrowserState(listener);
  push({ revision: 1, tabs: [tab] });
  unsubscribe();
  expect(listener).not.toHaveBeenCalled();
});

it.each([
  [
    { type: "open", tabId: "mac-1", url: "about:blank", sessionKey: "", activate: false },
    { ok: true, tabId: "mac-1" },
  ],
  [{ type: "present", scope: "scope", tabId: null, rect: null, visible: false }, { ok: true }],
  [{ type: "release-scope", scope: "scope" }, { ok: true }],
] satisfies [NativeBrowserMessage, unknown][])(
  "binds receiver and preserves request %j",
  async (message, reply) => {
    const posted = vi.fn();
    const bridge = {
      postMessage(request: NativeBrowserMessage) {
        expect(this).toBe(bridge);
        posted(request);
        return Promise.resolve(reply);
      },
    };
    vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: bridge } });
    expect(await postNativeBrowserMessage({ ...message })).toEqual(reply);
    expect(posted.mock.calls).toEqual([[message]]);
  },
);

const invalid = (kind: string) => ({ ok: false, error: `Invalid native browser ${kind}` });
it.each([
  ["download", { ok: true, cancelled: false }, { ok: true, cancelled: false }],
  ["download", { ok: true, cancelled: true }, { ok: true, cancelled: true }],
  ["download", { ok: true }, invalid("download")],
  ["download", { ok: true, cancelled: "false" }, invalid("download")],
  ["snapshot", { ...snapshotReply }, snapshotReply],
  ["snapshot", null, invalid("reply")],
  ["snapshot", { ok: true }, invalid("snapshot")],
  ["snapshot", { ...snapshotReply, dataUrl: "file:///example" }, invalid("snapshot")],
  ["snapshot", { ...snapshotReply, cssWidth: 0 }, invalid("snapshot")],
  ["reload", { ok: false, error: "Tab closed" }, { ok: false, error: "Tab closed" }],
  ["close", new Error("WebKit unavailable"), { ok: false, error: "WebKit unavailable" }],
] as const)("validates %s reply %j", async (type, reply, expected) => {
  const post = install();
  if (reply instanceof Error) {
    post.mockRejectedValueOnce(reply);
  } else {
    post.mockResolvedValueOnce(reply);
  }
  expect(await send(type)).toEqual(expected);
  expect(post).toHaveBeenCalledWith({ type, tabId: "mac-1" });
});

it("validates initial state and ignores malformed, duplicate, stale, and unsubscribed pushes", () => {
  install();
  vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", { revision: 2, tabs: [tab] });
  expect(readNativeBrowserState()).toEqual({ revision: 2, tabs: [tab] });
  const listener = vi.fn();
  const unsubscribe = subscribeNativeBrowserState(listener);
  for (const state of [
    { revision: 1, tabs: [tab] },
    { revision: 2, tabs: [] },
    { revision: 3, tabs: [tab, tab] },
    { revision: 3, tabs: [{ ...tab, openedBy: "other" }] },
    { revision: 3, tabs: [{ ...tab, loading: 1 }] },
    { revision: 3, tabs: [{ ...tab, sessionKey: null }] },
    { revision: 3, tabs: [{ ...tab, sessionKey: " session " }] },
    { revision: 3, tabs: [{ ...tab, url: "file:///example" }] },
    { revision: 3.5, tabs: [] },
  ]) {
    push(state);
  }
  expect(listener).not.toHaveBeenCalled();
  push({ revision: 3, tabs: [{ ...tab, openedBy: "native", openerTabId: "mac-opener" }] });
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
  push({ revision: 4, tabs: [] });
  expect(listener).toHaveBeenCalledOnce();
  vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", { revision: 5, tabs: [tab, tab] });
  expect(readNativeBrowserState()).toBeNull();
});

it.each([
  { name: "PNG", favicon: "data:image/png;base64,eA==", accepted: true },
  { name: "non-image", favicon: "data:text/html;base64,eA==", accepted: false },
  { name: "oversized", favicon: "data:image/png;base64," + "A".repeat(98_283), accepted: false },
  { name: "null", favicon: null, accepted: false },
])("validates $name favicon on initial reads and pushes", ({ favicon, accepted }) => {
  install();
  const state = { revision: 1, tabs: [{ ...tab, favicon }] };
  vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", state);
  expect(readNativeBrowserState()).toEqual(accepted ? state : null);
  const listener = vi.fn();
  const unsubscribe = subscribeNativeBrowserState(listener);
  try {
    const next = { ...state, revision: 2 };
    push(next);
    expect(listener.mock.calls).toEqual(accepted ? [[next]] : []);
  } finally {
    unsubscribe();
  }
});

it("shares one state listener and validates each pushed state once across many panels", () => {
  install();
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  let validationReads = 0;
  const pushedTab = {
    ...tab,
    get loading() {
      validationReads += 1;
      return false;
    },
  };
  const listeners = Array.from({ length: 20 }, () => vi.fn());
  const stops = listeners.map(subscribeNativeBrowserState);
  try {
    expect(
      add.mock.calls.filter(([type]) => type === "openclaw:native-browser-state"),
    ).toHaveLength(1);
    const state = { revision: 1, tabs: [pushedTab] };
    push(state);
    expect(validationReads).toBe(1);
    expect(listeners.every((listener) => listener.mock.calls[0]?.[0] === state)).toBe(true);
    stops[0]!();
    expect(
      remove.mock.calls.filter(([type]) => type === "openclaw:native-browser-state"),
    ).toHaveLength(0);
    push({ revision: 2, tabs: [pushedTab] });
    expect(listeners[0]).toHaveBeenCalledTimes(1);
    expect(listeners[1]).toHaveBeenCalledTimes(2);
  } finally {
    stops.forEach((stop) => stop());
    add.mockRestore();
  }
  expect(
    remove.mock.calls.filter(([type]) => type === "openclaw:native-browser-state"),
  ).toHaveLength(1);
  remove.mockRestore();
});

it("keeps revision floors local to each subscription and retires callbacks during dispatch", () => {
  install();
  vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", { revision: 2, tabs: [tab] });
  const first = vi.fn();
  const stopFirst = subscribeNativeBrowserState(first);
  vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", { revision: 5, tabs: [tab] });
  const second = vi.fn();
  const stopSecond = subscribeNativeBrowserState(second);
  let stopRetired = () => {};
  const stopRetiring = subscribeNativeBrowserState(() => stopRetired());
  const retired = vi.fn();
  stopRetired = subscribeNativeBrowserState(retired);
  try {
    push({ revision: 3, tabs: [tab] });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    push({ revision: 6, tabs: [tab] });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
    expect(retired).not.toHaveBeenCalled();
  } finally {
    stopFirst();
    stopSecond();
    stopRetiring();
    stopRetired();
  }
});

it("keeps sibling native state subscriptions live when a listener throws", () => {
  install();
  const report = vi.fn();
  vi.stubGlobal("reportError", report);
  const failure = new Error("panel failed");
  const stopFailed = subscribeNativeBrowserState(() => {
    throw failure;
  });
  const healthy = vi.fn();
  const stopHealthy = subscribeNativeBrowserState(healthy);
  try {
    push({ revision: 1, tabs: [tab] });
    expect(report).toHaveBeenCalledWith(failure);
    expect(healthy).toHaveBeenCalledTimes(1);
  } finally {
    stopFailed();
    stopHealthy();
  }
});
