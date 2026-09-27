/* @vitest-environment jsdom */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectToolResultDetails } from "../../../../../src/gateway/chat-display-projection.canvas.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import type { ApplicationGatewaySnapshot } from "../../../app/gateway.ts";
import type { BrowserTabTarget } from "../../../components/browser/browser-target.ts";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../../../components/panel-toggle-contract.ts";
import { latestBrowserTabCards } from "../../../lib/chat/browser-tab-preview.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { renderActivityGroup } from "./chat-message-group.ts";
import { renderToolPreview } from "./widget-card.ts";

const hosts: HTMLElement[] = [];

function messageEntries(messages: Array<{ toolCallId: string }>): MessageGroup["messages"] {
  return groupMessages(
    messages.map((message) => ({ kind: "message", key: message.toolCallId, message })),
  ).flatMap((item) => (item.kind === "group" ? item.messages : []));
}

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function gatewayContext(
  methods = ["browser.request"],
  scopes = ["operator.admin"],
  automaticallyFetchFavicons = false,
) {
  const request = vi.fn().mockResolvedValue({ path: "/tmp/tab.png" });
  const listeners = new Set<() => void>();
  const snapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: { features: { methods }, auth: { role: "operator", scopes } },
  } as ApplicationGatewaySnapshot;
  const context = {
    resourceBasePath: "/gateway",
    config: {
      current: { automaticallyFetchFavicons },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    gateway: {
      snapshot,
      connection: { token: "", password: "" },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as ApplicationContext;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      ({
        ok: true,
        blob: async () => new Blob(["thumbnail"], { type: "image/png" }),
      }) as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    context,
    request,
    fetchMock,
    snapshot,
    notify: () => listeners.forEach((listener) => listener()),
    listeners,
  };
}

function container() {
  const host = document.createElement("div");
  hosts.push(host);
  document.body.append(host);
  return host;
}

function browserResult(id: string, targetId: string, url: string | undefined) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "browser",
    content: "ok",
    details: { browserTab: { profile: "managed", target: "host", targetId, url, title: id } },
  };
}

async function drawActivity(
  host: HTMLElement,
  context: ApplicationContext,
  messages: ReturnType<typeof browserResult>[],
  expanded: boolean,
) {
  const group: MessageGroup = {
    kind: "group",
    key: "browser-results",
    role: "tool",
    visibleContent: "text",
    isStreaming: false,
    timestamp: 1,
    messages: messageEntries(messages),
  };
  render(
    renderActivityGroup([group], {
      showReasoning: false,
      latestBrowserTabs: latestBrowserTabCards(messages, []),
      isToolMessageExpanded: () => expanded,
    }),
    host,
  );
  const elements = [...host.querySelectorAll("openclaw-browser-tab-card")];
  for (const element of elements) {
    element.context = context;
    await element.updateComplete;
  }
  return elements;
}

async function card(
  context: ApplicationContext,
  latest = true,
  tab: BrowserTabTarget = { target: "host", profile: "managed", targetId: "tab-1" },
) {
  const host = container();
  render(
    renderToolPreview(
      { kind: "browser-tab", ...tab, url: "https://example.com/page" },
      "chat_tool",
      {
        browserTabRevision: "one",
        browserTabLatest: latest,
      },
    ),
    host,
  );
  const element = host.querySelector("openclaw-browser-tab-card")!;
  element.context = context;
  await element.updateComplete;
  return element;
}

describe("browser tab card", () => {
  it("shows the page favicon and social image even without a live browser tab", async () => {
    const gateway = gatewayContext([], ["operator.read"], true);
    gateway.request.mockResolvedValue({
      title: "Example page",
      faviconDataUrl: "data:image/png;base64,aWNvbg==",
      imageDataUrl: "data:image/png;base64,c29jaWFs",
    });
    const element = await card(gateway.context, false);
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector(".icon img")?.getAttribute("src")).toBe(
        "data:image/png;base64,aWNvbg==",
      ),
    );
    expect(element.shadowRoot?.querySelector(".shot img")?.getAttribute("src")).toBe(
      "data:image/png;base64,c29jaWFs",
    );
    expect(element.shadowRoot?.querySelector(".title")?.textContent).toBe("Example page");
    expect(gateway.request).toHaveBeenCalledExactlyOnceWith(
      "controlUi.linkPreview",
      { url: "https://example.com/page" },
      { signal: expect.any(AbortSignal) },
    );
    element.shadowRoot?.querySelector(".icon img")?.dispatchEvent(new Event("error"));
    element.shadowRoot?.querySelector(".shot img")?.dispatchEvent(new Event("error"));
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("img")).toBeNull();
    expect(element.shadowRoot?.querySelector(".icon svg")).not.toBeNull();
    expect(element.shadowRoot?.querySelector(".url")?.textContent).toBe("https://example.com/page");
  });

  it("discards late page metadata after navigation or disabling previews", async () => {
    const gateway = gatewayContext([], ["operator.read"], true);
    const pending = createDeferred<{ title: string; imageDataUrl: string }>();
    gateway.request.mockReturnValueOnce(pending.promise).mockResolvedValue({ title: "New page" });
    const element = await card(gateway.context, false);
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledOnce());
    element.preview = { ...element.preview!, url: "https://example.com/new" };
    await element.updateComplete;
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector(".title")?.textContent).toBe("New page"),
    );
    pending.resolve({ title: "Old page", imageDataUrl: "data:image/png;base64,b2xk" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(element.shadowRoot?.querySelector("img")).toBeNull();
    expect(element.shadowRoot?.querySelector(".title")?.textContent).toBe("New page");
    gateway.context.config.current.automaticallyFetchFavicons = false;
    gateway.notify();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector(".title")?.textContent).toBe("example.com");
    expect(gateway.request).toHaveBeenCalledTimes(2);
  });

  it("keeps the live screenshot ahead of the social image while using the favicon", async () => {
    const gateway = gatewayContext(["browser.request"], ["operator.admin"], true);
    gateway.request.mockImplementation(async (method: string) =>
      method === "controlUi.linkPreview"
        ? {
            imageDataUrl: "data:image/png;base64,c29jaWFs",
            faviconDataUrl: "data:image/png;base64,aWNvbg==",
          }
        : { path: "/tmp/tab.png" },
    );
    const element = await card(gateway.context);
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector(".shot img")?.getAttribute("src")).toBe(
        "data:image/png;base64,dGh1bWJuYWls",
      ),
    );
    expect(element.shadowRoot?.querySelector(".icon img")).not.toBeNull();
    expect(element.shadowRoot?.querySelector(".shot.social")).toBeNull();
  });

  it("shares metadata across cards only on the same connection", async () => {
    const first = gatewayContext([], ["operator.read"], true);
    first.request.mockResolvedValue({ title: "First gateway" });
    await card(first.context, false);
    const duplicate = await card(first.context, false);
    await vi.waitFor(() =>
      expect(duplicate.shadowRoot?.querySelector(".title")?.textContent).toBe("First gateway"),
    );
    expect(first.request).toHaveBeenCalledOnce();
    const second = gatewayContext([], ["operator.read"], true);
    second.request.mockResolvedValue({ title: "Second gateway" });
    duplicate.context = second.context;
    await duplicate.updateComplete;
    await vi.waitFor(() =>
      expect(duplicate.shadowRoot?.querySelector(".title")?.textContent).toBe("Second gateway"),
    );
    expect(second.request).toHaveBeenCalledOnce();
    second.snapshot.phase = "offline";
    second.notify();
    await duplicate.updateComplete;
    expect(duplicate.shadowRoot?.querySelector(".title")?.textContent).toBe("example.com");
  });

  it("retries a rejected preview when the same client reconnects", async () => {
    const gateway = gatewayContext([], ["operator.read"], true);
    const pending = createDeferred<unknown>();
    gateway.request.mockReturnValueOnce(pending.promise).mockResolvedValue({
      title: "Recovered preview",
      imageDataUrl: "data:image/png;base64,c29jaWFs",
    });
    const element = await card(gateway.context, false);
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledOnce());
    gateway.snapshot.phase = "offline";
    gateway.notify();
    await element.updateComplete;
    pending.reject(new Error("gateway closed"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    gateway.snapshot.phase = "connected";
    gateway.notify();
    await element.updateComplete;
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector(".title")?.textContent).toBe("Recovered preview"),
    );
    expect(element.shadowRoot?.querySelector(".shot img")).not.toBeNull();
    expect(gateway.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { methods: [], scopes: ["operator.admin"] },
    { methods: ["browser.request"], scopes: ["operator.read"] },
  ])("keeps a chip without advertised browser access (%j)", async ({ methods, scopes }) => {
    const gateway = gatewayContext(methods, scopes);
    const element = await card(gateway.context);
    expect(element.shadowRoot?.querySelector(".title")?.textContent).toBe("example.com");
    expect(element.shadowRoot?.querySelector("img")).toBeNull();
    expect(gateway.request).not.toHaveBeenCalled();
    expect(gateway.fetchMock).not.toHaveBeenCalled();
    const toggle = vi.fn<(event: Event) => void>();
    element.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, toggle);
    element.shadowRoot?.querySelector("button")?.click();
    expect(toggle).toHaveBeenCalledOnce();
    const event = toggle.mock.calls[0]?.[0];
    expect(event).toBeInstanceOf(CustomEvent);
    expect(event instanceof CustomEvent ? event.detail : undefined).toEqual({
      open: true,
      browserTab: { targetId: "tab-1", profile: "managed", target: "host" },
    });
  });

  it.each([
    { target: "host", profile: "managed", targetId: "t1" },
    { target: "node", node: "node-a", profile: "work", targetId: "t1" },
  ] as const)("keeps $target/$profile on the thumbnail and open action", async (tab) => {
    const gateway = gatewayContext();
    const element = await card(gateway.context, true, tab);
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector("img")).not.toBeNull());
    expect(gateway.request).toHaveBeenCalledWith("browser.request", {
      method: "POST",
      path: "/screenshot",
      target: tab.target,
      ...("node" in tab ? { node: tab.node } : {}),
      query: { profile: tab.profile },
      body: { targetId: "t1", type: "png" },
    });
    const toggle = vi.fn<(event: Event) => void>();
    element.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, toggle);
    element.shadowRoot?.querySelector<HTMLButtonElement>(".shot")?.click();
    expect(toggle).toHaveBeenCalledOnce();
    expect(toggle.mock.calls[0]?.[0]).toMatchObject({
      detail: { open: true, browserTab: tab },
    });
  });

  it("shares one screenshot between latest cards and leaves older cards as chips", async () => {
    const gateway = gatewayContext();
    const older = await card(gateway.context, false);
    const first = await card(gateway.context);
    const duplicate = await card(gateway.context);
    await vi.waitFor(() => expect(duplicate.shadowRoot?.querySelector("img")).not.toBeNull());
    expect(first.shadowRoot?.querySelector("img")).not.toBeNull();
    expect(older.shadowRoot?.querySelector("img")).toBeNull();
    expect(gateway.request).toHaveBeenCalledOnce();
    expect(gateway.fetchMock).toHaveBeenCalledOnce();
    first.remove();
    duplicate.remove();
    older.remove();
    expect(gateway.listeners.size).toBe(0);
    const remounted = await card(gateway.context);
    await vi.waitFor(() => expect(remounted.shadowRoot?.querySelector("img")).not.toBeNull());
    expect(gateway.request).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "collapses repeated page results and refreshes the newest completion (separate tabs: %s)",
    async (separateTabs) => {
      const gateway = gatewayContext();
      const message = (id: string, targetId = separateTabs ? id : "tab-1") =>
        browserResult(id, targetId, "https://example.com");
      const host = container();
      const messages = [message("first"), message("second"), message("old"), message("new")];
      const draw = (expanded: boolean) => drawActivity(host, gateway.context, messages, expanded);
      // Reopening the same page must not expose verification tabs as duplicate cards.
      const initial = await draw(false);
      expect(initial).toHaveLength(1);
      expect(initial[0]?.shadowRoot?.querySelector(".title")?.textContent).toBe("new");
      expect(initial.every((element) => !element.closest(".chat-activity-group__body"))).toBe(true);
      await vi.waitFor(() => expect(initial[0]?.shadowRoot?.querySelector("img")).not.toBeNull());
      expect(await draw(true)).toHaveLength(1);
      expect(gateway.request).toHaveBeenCalledOnce();
      messages.push(message("newest", separateTabs ? "first" : "tab-1"));
      const next = await draw(false);
      expect(next).toHaveLength(1);
      expect(next[0]?.shadowRoot?.querySelector(".title")?.textContent).toBe("newest");
      const toggle = vi.fn<(event: Event) => void>();
      next[0]?.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, toggle);
      next[0]?.shadowRoot?.querySelector<HTMLButtonElement>(".actions button")?.click();
      expect(toggle.mock.calls[0]?.[0]).toMatchObject({
        detail: {
          open: true,
          browserTab: {
            target: "host",
            profile: "managed",
            targetId: separateTabs ? "first" : "tab-1",
          },
        },
      });
      await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(next[0]?.shadowRoot?.querySelector("img")).not.toBeNull());
    },
  );

  it.each(["about:blank", undefined])(
    "uses the latest successful result per tab before deciding to preview %s",
    async (latestUrl) => {
      const gateway = gatewayContext();
      const messages = [
        browserResult("old", "tab-1", "https://example.com/old"),
        browserResult("new", "tab-1", latestUrl),
        browserResult("other", "tab-2", "https://example.com/other"),
      ];
      const host = container();
      const elements = await drawActivity(host, gateway.context, messages, false);
      expect(
        elements.map((element) => element.shadowRoot?.querySelector(".title")?.textContent),
      ).toEqual(["other"]);
    },
  );

  it.each([
    { name: "path", tab: {}, url: "https://example.com/other" },
    { name: "query", tab: {}, url: "https://example.com/blog?theme=light" },
    { name: "fragment", tab: {}, url: "https://example.com/blog#mobile" },
    { name: "profile", tab: { profile: "work" }, url: "https://example.com/blog" },
    { name: "host", tab: { target: "node", node: "node-a" }, url: "https://example.com/blog" },
    { name: "node", tab: { node: "node-b" }, url: "https://example.com/blog" },
    { name: "long URL", tab: {}, url: `https://example.com/blog?value=${"x".repeat(2_100)}b` },
  ])("keeps different $name previews separate", async ({ name, tab, url }) => {
    const route = name === "node" ? { target: "node", node: "node-a" } : { target: "host" };
    const firstUrl =
      name === "long URL"
        ? `https://example.com/blog?value=${"x".repeat(2_100)}a`
        : "https://example.com/blog";
    const messages = [
      { targetId: "first", ...route, url: firstUrl },
      { targetId: "second", ...route, ...tab, url },
    ].map((browserTab, index) => ({
      role: "toolResult",
      toolCallId: `call-${index}`,
      toolName: "browser",
      content: "ok",
      details: { browserTab: { profile: "managed", ...browserTab } },
    }));
    const host = container();
    const group: MessageGroup = {
      kind: "group",
      key: "browser-results",
      role: "tool",
      visibleContent: "text",
      isStreaming: false,
      timestamp: 1,
      messages: messageEntries(messages),
    };
    render(renderActivityGroup([group], { showReasoning: false }), host);
    const elements = [...host.querySelectorAll("openclaw-browser-tab-card")];
    expect(elements).toHaveLength(2);
    expect(elements.map((element) => element.preview?.targetId)).toEqual(["first", "second"]);
  });

  it.each(
    [2_046, 2_047, 2_048].flatMap((length) =>
      [false, true].map((history) => ({ length, history })),
    ),
  )(
    "preserves ambiguous URL prefixes ($length units, history: $history)",
    ({ length, history }) => {
      const prefix = "https://example.com/blog?value=".padEnd(length, "x");
      const messages = ["first", "second"].map((targetId) => {
        const url =
          length === 2_046 ? prefix : `${prefix}${length === 2_047 ? "😀" : ""}${targetId}`;
        const browserTab = { target: "host", profile: "managed", targetId, url };
        return {
          role: "toolResult",
          toolName: "browser",
          toolCallId: targetId,
          content: "ok",
          details: history
            ? projectToolResultDetails({ browserTab }, 2_048).details
            : { browserTab: { ...browserTab, url: truncateUtf16Safe(url, 2_048) } },
        };
      });
      const group: MessageGroup = {
        kind: "group",
        key: "bounded-browser-results",
        role: "tool",
        visibleContent: "text",
        isStreaming: false,
        timestamp: 1,
        messages: messageEntries(messages),
      };
      const host = container();
      render(renderActivityGroup([group], { showReasoning: false }), host);
      const elements = [...host.querySelectorAll("openclaw-browser-tab-card")];
      expect(elements.map((element) => element.preview?.targetId)).toEqual(
        length === 2_046 ? ["second"] : ["first", "second"],
      );
      expect(elements.every((element) => element.preview?.url.length === length)).toBe(true);
    },
  );

  it("discards a pending image when browser access disappears", async () => {
    const gateway = gatewayContext();
    const pending = createDeferred<{ path: string }>();
    gateway.request.mockReturnValueOnce(pending.promise);
    const element = await card(gateway.context);
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledOnce());
    gateway.snapshot.phase = "offline";
    gateway.notify();
    await element.updateComplete;
    pending.resolve({ path: "/tmp/tab.png" });
    await vi.waitFor(() => expect(gateway.fetchMock).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(element.shadowRoot?.querySelector("img")).toBeNull();
  });
});
