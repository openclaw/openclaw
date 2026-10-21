/* @vitest-environment jsdom */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSignal } from "solid-js";
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
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createInitializationContext } from "../chat-pane.test-support.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { BrowserTabCardHost } from "./browser-tab-card.tsx";
import { ActivityGroup } from "./chat-message-group-view.tsx";

const hosts: HTMLElement[] = [];
type ActivityProps = Parameters<typeof ActivityGroup>[0];
const activityGroups = new Map<HTMLElement, (props: ActivityProps) => void>();
type CardProps = Parameters<typeof BrowserTabCardHost>[0];
const cards = new Map<
  HTMLElement,
  {
    props: CardProps;
    update: (props: CardProps) => void;
    unmount: () => void;
  }
>();

function drawGroup(host: HTMLElement, props: ActivityProps, context?: ApplicationContext) {
  const update = activityGroups.get(host);
  if (update) {
    update(props);
  } else {
    mountSolid(
      () => {
        const [current, setCurrent] = createSignal(props);
        activityGroups.set(host, setCurrent);
        return context ? (
          <ApplicationProvider value={context}>
            <ActivityGroup {...current()} />
          </ApplicationProvider>
        ) : (
          <ActivityGroup {...current()} />
        );
      },
      { container: host },
    );
  }
  flush();
}

function updateCard(element: HTMLElement, patch: Partial<CardProps>) {
  const mounted = cards.get(element)!;
  mounted.props = { ...mounted.props, ...patch };
  mounted.update(mounted.props);
}

function updatePreview(element: HTMLElement, patch: { url?: string; title?: string }) {
  updateCard(element, { preview: { ...cards.get(element)!.props.preview!, ...patch } });
}

function openedTargets(elements: HTMLElement[]) {
  return elements.map((element) => {
    let targetId: string | undefined;
    element.addEventListener(
      BROWSER_PANEL_TOGGLE_EVENT,
      (event) => {
        // SAFETY: This handler receives the card's browser-panel event contract.
        targetId = (event as CustomEvent<{ browserTab: BrowserTabTarget }>).detail.browserTab
          .targetId;
      },
      { once: true },
    );
    element.querySelector<HTMLButtonElement>(".actions button")!.click();
    return targetId;
  });
}

function messageEntries(messages: Array<{ toolCallId: string }>): MessageGroup["messages"] {
  return groupMessages(
    messages.map((message) => ({ kind: "message", key: message.toolCallId, message })),
  ).flatMap((item) => (item.kind === "group" ? item.messages : []));
}

afterEach(() => {
  cleanupSolid();
  activityGroups.clear();
  cards.clear();
  for (const host of hosts.splice(0)) {
    host.remove();
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function gatewayContext(
  methods = ["browser.request"],
  scopes = ["operator.admin"],
  automaticallyFetchFavicons = false,
) {
  const request = vi.fn().mockResolvedValue({ path: "/tmp/tab.png" });
  const listeners = new Set<() => void>();
  const themeListeners = new Set<() => void>();
  const base = createInitializationContext();
  const snapshot: ApplicationGatewaySnapshot = {
    ...base.gateway.snapshot,
    client: { request, connected: true } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: gatewayHelloForMethods(methods, scopes),
  };
  const context: ApplicationContext = {
    ...base,
    resourceBasePath: "/gateway",
    theme: {
      ...base.theme,
      settings: { ...base.theme.settings, openLinksExternally: false },
      subscribe: (listener: () => void) => {
        themeListeners.add(listener);
        return () => themeListeners.delete(listener);
      },
    },
    config: {
      ...base.config,
      current: { ...base.config.current, automaticallyFetchFavicons },
      subscribe: (listener) => {
        const changed = () => listener(context.config.current);
        listeners.add(changed);
        return () => listeners.delete(changed);
      },
    },
    gateway: {
      ...base.gateway,
      snapshot,
      connection: { ...base.gateway.connection, token: "", password: "" },
      subscribe: (listener) => {
        const changed = () => listener(snapshot);
        listeners.add(changed);
        return () => listeners.delete(changed);
      },
    },
  };
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
    notifyTheme: () => themeListeners.forEach((listener) => listener()),
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
  drawGroup(
    host,
    {
      groups: [group],
      options: {
        showReasoning: false,
        latestBrowserTabs: latestBrowserTabCards(messages, []),
        isToolMessageExpanded: () => expanded,
      },
      presentation: "standalone",
    },
    context,
  );
  const elements = [...host.querySelectorAll<HTMLElement>("openclaw-browser-tab-card")];
  return elements;
}

async function card(
  context: ApplicationContext,
  latest = true,
  tab: BrowserTabTarget = { target: "host", profile: "managed", targetId: "tab-1" },
) {
  const props = {
    preview: { kind: "browser-tab", ...tab, url: "https://example.com/page" },
    revision: "one",
    latest,
    context,
  } satisfies CardProps;
  let update!: (props: CardProps) => void;
  const view = mountSolid(
    () => {
      const [current, setCurrent] = createSignal<CardProps>(props);
      update = setCurrent;
      return <BrowserTabCardHost {...current()} />;
    },
    { container: container() },
  );
  flush();
  const element = view.container.querySelector<HTMLElement>("openclaw-browser-tab-card")!;
  cards.set(element, { props, update, unmount: view.unmount });
  return element;
}

describe("browser tab card", () => {
  it("retains browser-title post text when metadata only supplies the author", async () => {
    vi.useFakeTimers();
    const gateway = gatewayContext([], ["operator.read"], true);
    gateway.request.mockResolvedValue({ title: "OpenClaw (@openclaw) on X" });
    const element = await card(gateway.context, false);
    updatePreview(element, {
      url: "https://x.com/openclaw/status/123",
      title: 'OpenClaw on X: "Text from the browser title" / X',
    });
    flush();
    await vi.runAllTimersAsync();
    flush();
    expect(element.querySelector(".tweet-author")?.textContent).toBe("OpenClaw");
    expect(element.querySelector(".tweet-handle")?.textContent).toBe("@openclaw");
    expect(element.querySelector(".tweet-text")?.textContent).toBe("Text from the browser title");
  });

  it.each([
    {
      url: "https://mobile.twitter.com/openclaw/status/123/photo/1?s=20",
      title: 'OpenClaw on Twitter: "A post from the page title" / Twitter',
      author: "OpenClaw",
      handle: "@openclaw",
      text: "A post from the page title",
    },
    {
      url: "https://x.com/openclaw/status/123",
      title: "Log in to X / X",
      author: "Post on X",
      handle: "@openclaw",
      text: undefined,
    },
    {
      url: "https://x.com/i/web/status/123",
      title: "X",
      author: "Post on X",
      handle: undefined,
      text: undefined,
    },
    {
      url: "https://x.com/i/status/123",
      title: "OpenClaw (@openclaw) / X",
      author: "OpenClaw",
      handle: "@openclaw",
      text: undefined,
    },
    {
      url: "https://www.x.com/openclaw/status/123",
      title: "Other (@another) on X",
      author: "Post on X",
      handle: "@openclaw",
      text: undefined,
    },
  ])("keeps an honest tweet fallback for $url", async ({ url, title, author, handle, text }) => {
    const gateway = gatewayContext([], ["operator.read"], false);
    const element = await card(gateway.context, false);
    updatePreview(element, { url, title });
    flush();
    expect(element.querySelector(".tweet-author")?.textContent).toBe(author);
    expect(element.querySelector(".tweet-handle")?.textContent).toBe(handle);
    expect(element.querySelector(".tweet-text")?.textContent).toBe(text);
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it.each([
    "https://x.com/openclaw",
    "https://x.com/search?q=post",
    "https://x.com.evil.example/openclaw/status/123",
    "https://x.com@evil.example/openclaw/status/123",
    "https://user:password@x.com/openclaw/status/123",
    "https://x.com/openclaw/status/not-a-post",
  ])("does not style a non-post URL as a tweet: %s", async (url) => {
    const gateway = gatewayContext([], ["operator.read"], false);
    const element = await card(gateway.context, false);
    updatePreview(element, { url });
    flush();
    expect(element.querySelector(".tweet")).toBeNull();
    expect(element.querySelector(".url")?.textContent).toBe(url);
  });

  it("renders untrusted post text literally and clears it when previews are disabled", async () => {
    vi.useFakeTimers();
    const gateway = gatewayContext([], ["operator.read"], true);
    const text = '"<img src=x onerror=alert(1)> & **not markdown**"';
    gateway.request.mockResolvedValue({ title: "OpenClaw (@openclaw)", description: text });
    const element = await card(gateway.context, false);
    updatePreview(element, { url: "https://x.com/openclaw/status/123" });
    flush();
    await vi.runAllTimersAsync();
    flush();
    expect(element.querySelector(".tweet-text")?.textContent).toBe(text);
    expect(element.querySelector(".tweet-text img")).toBeNull();
    gateway.context.config.current.automaticallyFetchFavicons = false;
    gateway.notify();
    flush();
    expect(element.querySelector(".tweet-text")).toBeNull();
    expect(element.querySelector(".tweet-author")?.textContent).toBe("Post on X");
  });

  it.each([false, true])(
    "follows live external-link preferences and keeps the menu override (native: %s)",
    async (native) => {
      vi.useFakeTimers();
      const gateway = gatewayContext([], ["operator.read"], true);
      gateway.request.mockResolvedValue({ imageDataUrl: "data:image/png;base64,c29jaWFs" });
      const element = await card(gateway.context, false);
      await vi.runAllTimersAsync();
      flush();
      expect(element.querySelector(".shot")).not.toBeNull();
      const openWindow = vi.spyOn(window, "open").mockReturnValue(null);
      const postMessage = vi.fn();
      if (native) {
        vi.stubGlobal("webkit", { messageHandlers: { openclawLink: { postMessage } } });
      }
      const toggle = vi.fn();
      element.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, toggle);
      const menu = () => element.querySelector('[role="menu"]')!;
      const select = async (value: string) => {
        element.querySelector<HTMLButtonElement>(".more")!.click();
        await waitForSolid(() => expect(menu().matches(":popover-open")).toBe(true));
        menu().querySelector<HTMLButtonElement>(`[value="${value}"]`)!.click();
        await waitForSolid(() => expect(menu().matches(":popover-open")).toBe(false));
      };
      expect(menu().textContent).toContain("Open in new tab");

      gateway.context.theme.settings.openLinksExternally = true;
      gateway.notifyTheme();
      flush();
      for (const selector of [".shot", ".actions button"]) {
        element.querySelector<HTMLButtonElement>(selector)!.click();
      }
      expect(toggle).not.toHaveBeenCalled();
      if (native) {
        expect(postMessage.mock.calls).toEqual([
          [{ type: "open-link", url: "https://example.com/page", target: "external" }],
          [{ type: "open-link", url: "https://example.com/page", target: "external" }],
        ]);
        expect(openWindow).not.toHaveBeenCalled();
      } else {
        expect(openWindow.mock.calls).toEqual([
          ["https://example.com/page", "_blank", "noopener,noreferrer"],
          ["https://example.com/page", "_blank", "noopener,noreferrer"],
        ]);
      }
      const internal = menu().querySelector('[value="open-within-openclaw"]')!;
      expect(internal.textContent).toContain("Open in OpenClaw");
      expect(internal.hasAttribute("data-new-tab-action")).toBe(false);
      expect(menu().querySelector('[value="open-new-tab"]')).toBeNull();
      await select("open-within-openclaw");
      expect(toggle).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          detail: {
            open: true,
            browserTab: { target: "host", profile: "managed", targetId: "tab-1" },
          },
        }),
      );

      gateway.context.theme.settings.openLinksExternally = false;
      gateway.notifyTheme();
      flush();
      expect(menu().textContent).toContain("Open in new tab");
      expect(menu().querySelector('[value="open-within-openclaw"]')).toBeNull();
      element.querySelector<HTMLButtonElement>(".shot")!.click();
      expect(toggle).toHaveBeenCalledTimes(2);
      await select("open-new-tab");
      expect(native ? postMessage : openWindow).toHaveBeenCalledTimes(3);
    },
  );

  it("shows the page favicon and social image even without a live browser tab", async () => {
    const gateway = gatewayContext([], ["operator.read"], true);
    const metadata = createDeferred<{
      title: string;
      faviconDataUrl: string;
      imageDataUrl: string;
    }>();
    gateway.request.mockReturnValue(metadata.promise);
    const element = await card(gateway.context, false);
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledOnce());
    expect(element.querySelector("img")).toBeNull();
    metadata.resolve({
      title: "Example page",
      faviconDataUrl: "data:image/png;base64,aWNvbg==",
      imageDataUrl: "data:image/png;base64,c29jaWFs",
    });
    await vi.waitFor(() =>
      expect(element.querySelector(".icon img")?.getAttribute("src")).toBe(
        "data:image/png;base64,aWNvbg==",
      ),
    );
    expect(element.querySelector(".shot img")?.getAttribute("src")).toBe(
      "data:image/png;base64,c29jaWFs",
    );
    expect(element.querySelector(".title")?.textContent).toBe("Example page");
    expect(gateway.request).toHaveBeenCalledExactlyOnceWith(
      "controlUi.linkPreview",
      { url: "https://example.com/page" },
      { signal: expect.any(AbortSignal) },
    );
    element.querySelector(".icon img")?.dispatchEvent(new Event("error"));
    element.querySelector(".shot img")?.dispatchEvent(new Event("error"));
    flush();
    expect(element.querySelector("img")).toBeNull();
    expect(element.querySelector(".icon svg")).not.toBeNull();
    expect(element.querySelector(".url")?.textContent).toBe("https://example.com/page");
  });

  it("discards late page metadata after navigation or disabling previews", async () => {
    const gateway = gatewayContext([], ["operator.read"], true);
    const pending = createDeferred<{ title: string; imageDataUrl: string }>();
    gateway.request.mockReturnValueOnce(pending.promise).mockResolvedValue({ title: "New page" });
    const element = await card(gateway.context, false);
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledOnce());
    updatePreview(element, { url: "https://example.com/new" });
    flush();
    await vi.waitFor(() => expect(element.querySelector(".title")?.textContent).toBe("New page"));
    pending.resolve({ title: "Old page", imageDataUrl: "data:image/png;base64,b2xk" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(element.querySelector("img")).toBeNull();
    expect(element.querySelector(".title")?.textContent).toBe("New page");
    gateway.context.config.current.automaticallyFetchFavicons = false;
    gateway.notify();
    flush();
    expect(element.querySelector(".title")?.textContent).toBe("example.com");
    expect(gateway.request).toHaveBeenCalledTimes(2);
  });

  it("retains failed images through screenshot refreshes and unavailable targets until a new target", async () => {
    const gateway = gatewayContext(["browser.request"], ["operator.admin"], true);
    const image = "data:image/png;base64,dGh1bWJuYWls";
    gateway.request.mockImplementation(async (method: string) =>
      method === "controlUi.linkPreview"
        ? { imageDataUrl: image, faviconDataUrl: "data:image/png;base64,aWNvbg==" }
        : { path: "/tmp/tab.png" },
    );
    const element = await card(gateway.context);
    await waitForSolid(() => {
      expect(element.querySelector(".shot img")?.getAttribute("src")).toBe(image);
      expect(element.querySelector(".shot.social")).toBeNull();
      expect(element.querySelector(".icon img")).not.toBeNull();
    });
    for (const img of element.querySelectorAll("img")) {
      img.dispatchEvent(new Event("error"));
    }
    flush();
    expect(element.querySelector("img")).toBeNull();

    updateCard(element, { revision: "two" });
    flush();
    await waitForSolid(() => expect(gateway.fetchMock).toHaveBeenCalledTimes(2));
    expect(element.querySelector("img")).toBeNull();

    gateway.context.config.current.automaticallyFetchFavicons = false;
    gateway.notify();
    flush();
    expect(element.querySelector("img")).toBeNull();
    updatePreview(element, { url: "https://example.com/new" });
    flush();
    expect(element.querySelector("img")).toBeNull();

    gateway.context.config.current.automaticallyFetchFavicons = true;
    gateway.notify();
    flush();
    await waitForSolid(() => {
      expect(element.querySelector(".shot img")?.getAttribute("src")).toBe(image);
      expect(element.querySelector(".icon img")).not.toBeNull();
    });
  });

  it("keeps the live screenshot ahead of the social image while using the favicon", async () => {
    const gateway = gatewayContext(["browser.request"], ["operator.admin"], true);
    const screenshot = createDeferred<{ path: string }>();
    gateway.request.mockImplementation(async (method: string) =>
      method === "controlUi.linkPreview"
        ? {
            imageDataUrl: "data:image/png;base64,c29jaWFs",
            faviconDataUrl: "data:image/png;base64,aWNvbg==",
          }
        : screenshot.promise,
    );
    const element = await card(gateway.context);
    await vi.waitFor(() =>
      expect(element.querySelector(".shot.social img")?.getAttribute("src")).toBe(
        "data:image/png;base64,c29jaWFs",
      ),
    );
    screenshot.resolve({ path: "/tmp/tab.png" });
    await vi.waitFor(() =>
      expect(element.querySelector(".shot img")?.getAttribute("src")).toBe(
        "data:image/png;base64,dGh1bWJuYWls",
      ),
    );
    expect(element.querySelector(".icon img")).not.toBeNull();
    expect(element.querySelector(".shot.social")).toBeNull();
  });

  it("shares metadata across cards only on the same connection", async () => {
    const first = gatewayContext([], ["operator.read"], true);
    first.request.mockResolvedValue({ title: "First gateway" });
    await card(first.context, false);
    const duplicate = await card(first.context, false);
    await vi.waitFor(() =>
      expect(duplicate.querySelector(".title")?.textContent).toBe("First gateway"),
    );
    expect(first.request).toHaveBeenCalledOnce();
    const second = gatewayContext([], ["operator.read"], true);
    second.request.mockResolvedValue({ title: "Second gateway" });
    updateCard(duplicate, { context: second.context });
    flush();
    await vi.waitFor(() =>
      expect(duplicate.querySelector(".title")?.textContent).toBe("Second gateway"),
    );
    expect(second.request).toHaveBeenCalledOnce();
    second.snapshot.phase = "offline";
    second.notify();
    flush();
    expect(duplicate.querySelector(".title")?.textContent).toBe("example.com");
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
    flush();
    pending.reject(new Error("gateway closed"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    gateway.snapshot.phase = "connected";
    gateway.notify();
    flush();
    await vi.waitFor(() =>
      expect(element.querySelector(".title")?.textContent).toBe("Recovered preview"),
    );
    expect(element.querySelector(".shot img")).not.toBeNull();
    expect(gateway.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { methods: [], scopes: ["operator.admin"] },
    { methods: ["browser.request"], scopes: ["operator.read"] },
  ])("keeps a chip without advertised browser access (%j)", async ({ methods, scopes }) => {
    const gateway = gatewayContext(methods, scopes);
    const element = await card(gateway.context);
    expect(element.querySelector(".title")?.textContent).toBe("example.com");
    expect(element.querySelector("img")).toBeNull();
    expect(gateway.request).not.toHaveBeenCalled();
    expect(gateway.fetchMock).not.toHaveBeenCalled();
    const toggle = vi.fn<(event: Event) => void>();
    element.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, toggle);
    element.querySelector("button")?.click();
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
    await vi.waitFor(() => expect(element.querySelector("img")).not.toBeNull());
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
    element.querySelector<HTMLButtonElement>(".shot")?.click();
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
    await vi.waitFor(() => expect(duplicate.querySelector("img")).not.toBeNull());
    expect(first.querySelector("img")).not.toBeNull();
    expect(older.querySelector("img")).toBeNull();
    expect(gateway.request).toHaveBeenCalledOnce();
    expect(gateway.fetchMock).toHaveBeenCalledOnce();
    cards.get(first)!.unmount();
    cards.get(duplicate)!.unmount();
    cards.get(older)!.unmount();
    await Promise.resolve();
    expect(gateway.listeners.size).toBe(0);
    const remounted = await card(gateway.context);
    await vi.waitFor(() => expect(remounted.querySelector("img")).not.toBeNull());
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
      expect(initial[0]?.querySelector(".title")?.textContent).toBe("new");
      expect(initial.every((element) => !element.closest(".chat-activity-group__body"))).toBe(true);
      await vi.waitFor(() => expect(initial[0]?.querySelector("img")).not.toBeNull());
      expect(await draw(true)).toHaveLength(1);
      expect(gateway.request).toHaveBeenCalledOnce();
      messages.push(message("newest", separateTabs ? "first" : "tab-1"));
      const next = await draw(false);
      expect(next).toHaveLength(1);
      expect(next[0]?.querySelector(".title")?.textContent).toBe("newest");
      const toggle = vi.fn<(event: Event) => void>();
      next[0]?.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, toggle);
      next[0]?.querySelector<HTMLButtonElement>(".actions button")?.click();
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
      await vi.waitFor(() => expect(next[0]?.querySelector("img")).not.toBeNull());
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
      expect(elements.map((element) => element.querySelector(".title")?.textContent)).toEqual([
        "other",
      ]);
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
    drawGroup(host, {
      groups: [group],
      options: { showReasoning: false },
      presentation: "standalone",
    });
    const elements = [...host.querySelectorAll<HTMLElement>("openclaw-browser-tab-card")];
    expect(elements).toHaveLength(2);
    expect(openedTargets(elements)).toEqual(["first", "second"]);
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
      drawGroup(host, {
        groups: [group],
        options: { showReasoning: false },
        presentation: "standalone",
      });
      const elements = [...host.querySelectorAll<HTMLElement>("openclaw-browser-tab-card")];
      expect(openedTargets(elements)).toEqual(length === 2_046 ? ["second"] : ["first", "second"]);
      expect(
        elements.every((element) => element.querySelector(".url")?.textContent?.length === length),
      ).toBe(true);
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
    flush();
    pending.resolve({ path: "/tmp/tab.png" });
    await vi.waitFor(() => expect(gateway.fetchMock).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(element.querySelector("img")).toBeNull();
  });
});
