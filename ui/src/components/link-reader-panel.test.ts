import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiLinkReaderDocument,
  ControlUiLinkReaderDescriptor,
} from "../../../src/shared/control-ui-link-reader.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { LINK_READER_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import "./link-reader-panel.ts";

type Panel = HTMLElementTagNameMap["openclaw-link-reader-panel"];
const storageKey = "openclaw.link-reader.panel.v1";
const itemUrl = (number: number) => "https://forge.example/items/" + number;
const reader: ControlUiLinkReaderDescriptor = {
  pluginId: "forge",
  id: "items",
  label: "Forge",
  icon: "externalLink",
  linkReader: {
    hosts: ["forge.example"],
    pathPattern: "^/items/[1-9][0-9]*$",
    detailMethod: "forge.item",
  },
};
function item(number = 1): ControlUiLinkReaderDocument {
  return {
    url: itemUrl(number),
    title: "Item " + number,
    author: "reporter",
    badge: { label: "Open", tone: "positive" },
    createdAt: "2026-09-01T12:00:00Z",
    updatedAt: "2026-09-02T12:00:00Z",
    body: "**Description**",
    comments: [
      {
        id: "comment-4",
        url: itemUrl(number) + "#comment-4",
        author: "reviewer",
        createdAt: "2026-09-02T12:00:00Z",
        body: "Comment text",
      },
    ],
    commentsTotal: 1,
  };
}
function requestedItem(params: unknown): ControlUiLinkReaderDocument {
  return item(Number(new URL((params as { url: string }).url).pathname.split("/").at(-1)));
}

function deferredDetail() {
  let resolve!: (value: ControlUiLinkReaderDocument) => void;
  const promise = new Promise<ControlUiLinkReaderDocument>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mount(
  request: (
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>,
  options: Partial<
    Pick<Panel, "embedded" | "presented" | "sessionKey" | "tabsInHeader" | "onClose">
  > = {},
) {
  const panel = document.createElement("openclaw-link-reader-panel");
  panel.client = { request } as unknown as GatewayBrowserClient;
  panel.available = true;
  panel.readers = [reader];
  Object.assign(panel, options);
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function open(panel: Panel, url = itemUrl(1), trigger?: HTMLElement, newTab = false) {
  panel.handleToggleRequest(
    new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
      detail: { url, open: true, trigger, newTab },
      cancelable: true,
    }),
  );
}

function button(panel: Panel, label: string) {
  const result = panel.renderRoot.querySelector<HTMLButtonElement>(
    'button[aria-label="' + label + '"]',
  );
  if (!result) {
    throw new Error("Missing button: " + label);
  }
  return result;
}

async function expectTitle(panel: Panel, title: string) {
  await waitForFast(() =>
    expect(panel.renderRoot.querySelector(".lr-content:not([hidden]) h1")?.textContent).toBe(title),
  );
}

describe("Plugin link reader panel", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("resolves document images through the reader, deduplicates attachments, and preserves source links", async () => {
    const url = "https://images.example/attachment.png";
    const dataUrl = "data:image/png;base64,aW1hZ2U=";
    const request = vi.fn(async (method: string) =>
      method === "forge.image"
        ? { url, dataUrl }
        : {
            ...item(),
            body: `![Screenshot](${url})`,
            comments: [
              { id: "comment", url: itemUrl(1), author: "reviewer", body: `![Repeated](${url})` },
            ],
          },
    );
    const panel = await mount(request);
    panel.readers = [
      { ...reader, linkReader: { ...reader.linkReader, imageMethod: "forge.image" } },
    ];
    await panel.updateComplete;
    open(panel);
    await waitForFast(() =>
      expect([...panel.renderRoot.querySelectorAll("img")].map((image) => image.src)).toEqual([
        dataUrl,
        dataUrl,
      ]),
    );
    expect(request.mock.calls.filter(([method]) => method === "forge.image")).toHaveLength(1);
    expect(panel.renderRoot.querySelector<HTMLAnchorElement>(".lr-image a")?.href).toBe(url);
  });

  it("cancels retired document image requests and ignores late results after a connection replacement", async () => {
    const url = "https://images.example/pending.png";
    let finish!: (value: unknown) => void;
    let imageSignal: AbortSignal | undefined;
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "forge.image") {
          imageSignal = options?.signal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        }
        return { ...item(), body: `![Pending](${url})` };
      },
    );
    const panel = await mount(request);
    panel.readers = [
      { ...reader, linkReader: { ...reader.linkReader, imageMethod: "forge.image" } },
    ];
    await panel.updateComplete;
    open(panel);
    await waitForFast(() => expect(imageSignal).toBeDefined());
    const oldImage = panel.renderRoot.querySelector("img")!;
    expect(oldImage.hasAttribute("src")).toBe(false);
    panel.client = {
      request: vi.fn().mockResolvedValue(item()),
    } as unknown as GatewayBrowserClient;
    await panel.updateComplete;
    expect(imageSignal?.aborted).toBe(true);
    finish({ url, dataUrl: "data:image/png;base64,aW1hZ2U=" });
    await expectTitle(panel, "Item 1");
    expect(oldImage.hasAttribute("src")).toBe(false);
    expect(panel.renderRoot.querySelector("img")).toBeNull();
  });

  it("bounds image fanout and cancels queued work when its tab is removed", async () => {
    const signals: AbortSignal[] = [];
    const panel = await mount(async (method, _params, options) => {
      if (method !== "forge.image") {
        return {
          ...item(),
          body: Array.from(
            { length: 40 },
            (_, i) => `![Image ${i}](https://images.example/${i}.png)`,
          ).join("\n\n"),
        };
      }
      const signal = options!.signal!;
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    panel.readers = [
      { ...reader, linkReader: { ...reader.linkReader, imageMethod: "forge.image" } },
    ];
    await panel.updateComplete;
    open(panel);
    await waitForFast(() => expect(signals).toHaveLength(4));
    await panel.closeHostedTab(panel.activeHostedTabId!);
    await waitForFast(() => expect(signals.every((signal) => signal.aborted)).toBe(true));
    expect(signals).toHaveLength(4);
  });

  it.each([
    { url: "https://images.example/wrong.png", dataUrl: "data:image/png;base64,aW1hZ2U=" },
    { url: "https://images.example/image.png", dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
    { url: "https://images.example/image.png", dataUrl: "https://images.example/credentialed.png" },
  ])(
    "falls back only to the original anonymous image URL after an invalid response: $dataUrl",
    async (response) => {
      const url = "https://images.example/image.png";
      const panel = await mount(
        vi.fn(async (method) =>
          method === "forge.image" ? response : { ...item(), body: `![Screenshot](${url})` },
        ),
      );
      panel.readers = [
        { ...reader, linkReader: { ...reader.linkReader, imageMethod: "forge.image" } },
      ];
      await panel.updateComplete;
      open(panel);
      await waitForFast(() => expect(panel.renderRoot.querySelector("img")?.src).toBe(url));
      expect(panel.renderRoot.querySelector("img")?.crossOrigin).toBe("anonymous");
      expect(panel.renderRoot.querySelector<HTMLAnchorElement>(".lr-image a")?.href).toBe(url);
    },
  );

  it("accepts the same document identity when only the requested anchor differs", async () => {
    const panel = await mount(vi.fn().mockResolvedValue(item(1)));
    open(panel, itemUrl(1) + "#comment-4");
    await expectTitle(panel, "Item 1");
  });

  it("passes the selected agent to the detail identity owner", async () => {
    const request = vi.fn(async (_method: string, params?: unknown) => {
      if (
        Object.keys(params as object).some((key) => !["url", "refresh", "agentId"].includes(key))
      ) {
        throw new Error("Unexpected detail parameter");
      }
      return requestedItem(params);
    });
    const panel = await mount(request);
    panel.agentId = "selected-agent";
    open(panel);
    await expectTitle(panel, "Item 1");
    expect(request).toHaveBeenCalledWith(
      "forge.item",
      { url: itemUrl(1), agentId: "selected-agent" },
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([itemUrl(2), itemUrl(1) + "?resource=other"])(
    "rejects a document for another target: %s",
    async (url) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce({ ...item(2), url })
        .mockResolvedValueOnce(item(1));
      const panel = await mount(request);
      open(panel);
      await waitForFast(() => expect(panel.renderRoot.querySelector(".lr-retry")).not.toBeNull());
      expect(panel.renderRoot.querySelector("h1")).toBeNull();
      panel.renderRoot.querySelector<HTMLButtonElement>(".lr-retry")?.click();
      await expectTitle(panel, "Item 1");
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("receives embedded intents only from its owner and never writes standalone geometry", async () => {
    const request = vi.fn(async (_method: string, params?: unknown) => requestedItem(params));
    const first = await mount(request, {
      embedded: true,
      presented: true,
      sessionKey: "session-a",
    });
    const second = await mount(request, {
      embedded: true,
      presented: true,
      sessionKey: "session-b",
    });
    const broadcast = new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
      detail: { url: itemUrl(1), open: true },
      cancelable: true,
    });
    window.dispatchEvent(broadcast);
    await Promise.all([first.updateComplete, second.updateComplete]);
    expect(broadcast.defaultPrevented).toBe(false);
    expect(request).not.toHaveBeenCalled();

    open(first);
    await expectTitle(first, "Item 1");
    expect(second.renderRoot.querySelector("h1")).toBeNull();
    expect(first.renderRoot.querySelector(".bp--embedded")).not.toBeNull();
    expect(first.renderRoot.querySelector("resizable-divider")).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();

    const standalone = await mount(request);
    open(standalone, itemUrl(2));
    await expectTitle(standalone, "Item 2");
    first.requestUpdate();
    await first.updateComplete;
    second.remove();
    expect(document.documentElement.style.getPropertyValue("--oc-link-reader-reserve-right")).toBe(
      "560px",
    );
  });

  it("retains embedded tab history while hidden, and fences work from a previous session", async () => {
    const stale = deferredDetail();
    const request = vi.fn(async (_method: string, params?: unknown) => requestedItem(params));
    const panel = await mount(request, {
      embedded: true,
      presented: true,
      sessionKey: "session-a",
    });
    open(panel, itemUrl(1));
    await expectTitle(panel, "Item 1");
    open(panel, itemUrl(2));
    await expectTitle(panel, "Item 2");
    const content = panel.renderRoot.querySelector(".lr-content");
    panel.presented = false;
    await panel.updateComplete;
    open(panel, itemUrl(3));
    panel.presented = true;
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".lr-content")).toBe(content);
    expect(request).toHaveBeenCalledTimes(2);
    button(panel, "Back").click();
    await expectTitle(panel, "Item 1");

    request.mockReturnValueOnce(stale.promise);
    open(panel, itemUrl(4));
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));
    panel.sessionKey = "session-b";
    await panel.updateComplete;
    stale.resolve(item(4));
    await stale.promise;
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector("h1")).toBeNull();
    expect(button(panel, "Back").disabled).toBe(true);
    expect(panel.renderRoot.querySelector<HTMLInputElement>(".lr-url")?.value).toBe("");
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it("delegates header tabs and last-tab removal to the region without recreating a draft", async () => {
    const onClose = vi.fn();
    const panel = await mount(
      vi.fn(async () => item()),
      {
        embedded: true,
        presented: true,
        tabsInHeader: true,
        sessionKey: "session-a",
        onClose,
      },
    );
    open(panel);
    await expectTitle(panel, "Item 1");
    expect(panel.renderRoot.querySelector(".lr-tab-header")).toBeNull();
    expect(panel.hostedTabs).toMatchObject([{ label: "Item 1", url: itemUrl(1) }]);
    panel.tabsInHeader = false;
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".lr-tab-header")).not.toBeNull();
    await panel.closeHostedTab(panel.activeHostedTabId!);
    expect(onClose).toHaveBeenCalledOnce();
    expect(panel.hostedTabs).toEqual([]);
    expect(panel.renderRoot.querySelector(".link-reader-panel")).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it("loads only an explicitly selected item and persists layout, not content or history", async () => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ open: true, dock: "right", width: 560, height: 420 }),
    );
    const request = vi.fn(async () => item());
    const panel = await mount(request);
    expect(request).not.toHaveBeenCalled();
    expect(panel.renderRoot.querySelector(".bp")).toBeNull();
    open(panel);
    await expectTitle(panel, "Item 1");
    expect(request).toHaveBeenCalledWith(
      "forge.item",
      { url: itemUrl(1) },
      { signal: expect.any(AbortSignal) },
    );
    expect(panel.renderRoot.querySelector(".lr-description strong")?.textContent).toBe(
      "Description",
    );
    expect(panel.renderRoot.querySelector(".lr-comment")?.textContent).toContain("Comment text");
    expect(panel.renderRoot.querySelector(".lr-files")).toBeNull();
    expect(panel.renderRoot.querySelector(".lr-state")?.textContent).toBe("Open");
    expect(panel.renderRoot.querySelector("time")?.dateTime).toBe("2026-09-01T12:00:00Z");
    open(panel);
    await panel.updateComplete;
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(storageKey) ?? "null")).toEqual({
      open: true,
      dock: "right",
      width: 560,
      height: 420,
    });
  });

  it("navigates backward and forward, drops the forward branch, and refreshes without adding history", async () => {
    const request = vi.fn(async (_method: string, params: unknown) => requestedItem(params));
    const panel = await mount(request);
    open(panel);
    await expectTitle(panel, "Item 1");
    open(panel, itemUrl(2));
    await expectTitle(panel, "Item 2");
    button(panel, "Back").click();
    await expectTitle(panel, "Item 1");
    button(panel, "Forward").click();
    await expectTitle(panel, "Item 2");
    button(panel, "Back").click();
    await expectTitle(panel, "Item 1");
    open(panel, itemUrl(3));
    await expectTitle(panel, "Item 3");
    expect(button(panel, "Forward").disabled).toBe(true);
    button(panel, "Refresh item").click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(7));
    await expectTitle(panel, "Item 3");
    button(panel, "Back").click();
    await expectTitle(panel, "Item 1");
  });

  it("opens, selects, deduplicates, and closes icon-bearing tabs without reloading cached documents", async () => {
    const request = vi.fn(async (_method: string, params: unknown) => requestedItem(params));
    const panel = await mount(request);
    open(panel, itemUrl(1), undefined, true);
    await expectTitle(panel, "Item 1");
    const firstContent = panel.renderRoot.querySelector(".lr-content");
    open(panel, itemUrl(2), undefined, true);
    await expectTitle(panel, "Item 2");
    expect(panel.renderRoot.querySelectorAll("wa-tab")).toHaveLength(2);
    expect(panel.renderRoot.querySelectorAll(".tabstrip-tab__icon svg")).toHaveLength(2);
    open(panel, itemUrl(1), undefined, true);
    await expectTitle(panel, "Item 1");
    expect(panel.renderRoot.querySelectorAll("wa-tab")).toHaveLength(2);
    expect(panel.renderRoot.querySelector(".lr-content:not([hidden])")).toBe(firstContent);
    expect(request).toHaveBeenCalledTimes(2);
    expect(panel.renderRoot.querySelector<HTMLAnchorElement>(".lr-external")?.href).toBe(
      itemUrl(1),
    );
    panel.renderRoot.querySelectorAll<HTMLButtonElement>(".tabstrip-tab__close")[1]?.click();
    await panel.updateComplete;
    await expectTitle(panel, "Item 1");
    expect(panel.renderRoot.querySelectorAll("wa-tab")).toHaveLength(1);
    panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-tab__close")?.click();
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".link-reader-panel")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--oc-link-reader-reserve-right")).toBe(
      "0px",
    );
  });

  it("keeps history inside each tab and leaves the selected tab intact at the tab limit", async () => {
    const request = vi.fn(async (_method: string, params: unknown) => requestedItem(params));
    const panel = await mount(request);
    open(panel, itemUrl(1), undefined, true);
    await expectTitle(panel, "Item 1");
    open(panel, itemUrl(99));
    await expectTitle(panel, "Item 99");
    open(panel, itemUrl(2), undefined, true);
    await expectTitle(panel, "Item 2");
    expect(button(panel, "Back").disabled).toBe(true);
    open(panel, itemUrl(99), undefined, true);
    await expectTitle(panel, "Item 99");
    button(panel, "Back").click();
    await expectTitle(panel, "Item 1");
    for (let number = 3; number <= 10; number++) {
      open(panel, itemUrl(number), undefined, true);
      await expectTitle(panel, "Item " + number);
    }
    const calls = request.mock.calls.length;
    open(panel, itemUrl(11), undefined, true);
    await panel.updateComplete;
    expect(panel.renderRoot.querySelectorAll("wa-tab")).toHaveLength(10);
    await expectTitle(panel, "Item 10");
    expect(request).toHaveBeenCalledTimes(calls);
    expect(
      panel.renderRoot.querySelector<HTMLAnchorElement>('.lr-note[role="alert"] a')?.href,
    ).toBe(itemUrl(11));
  });

  it("validates the new-tab address bar before requesting a document", async () => {
    const request = vi.fn(async (_method: string, params: unknown) => requestedItem(params));
    const panel = await mount(request);
    open(panel);
    await expectTitle(panel, "Item 1");
    panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-new")?.click();
    await panel.updateComplete;
    const input = panel.renderRoot.querySelector<HTMLInputElement>(".lr-url")!;
    const form = panel.renderRoot.querySelector("form")!;
    input.value = "https://example.com/not-supported";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await panel.updateComplete;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(request).toHaveBeenCalledTimes(1);
    input.value = itemUrl(7);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await expectTitle(panel, "Item 7");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps at most 30 history entries in this mounted panel", async () => {
    const panel = await mount(
      vi.fn(async (_method: string, params?: unknown) => requestedItem(params)),
    );
    for (let number = 1; number <= 31; number++) {
      open(panel, itemUrl(number));
      await expectTitle(panel, "Item " + number);
    }
    for (let number = 30; number >= 2; number--) {
      button(panel, "Back").click();
      await expectTitle(panel, "Item " + number);
    }
    expect(button(panel, "Back").disabled).toBe(true);
    expect(button(panel, "Forward").disabled).toBe(false);
  });

  it("aborts superseded requests and ignores old navigation and client responses", async () => {
    const first = deferredDetail();
    const second = deferredDetail();
    const request = vi
      .fn<
        (
          _method: string,
          _params?: unknown,
          options?: { signal?: AbortSignal },
        ) => Promise<ControlUiLinkReaderDocument>
      >()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const panel = await mount(request);
    open(panel);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    open(panel, itemUrl(2));
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    first.resolve(item(1));
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector("h1")).toBeNull();
    const replacement = vi.fn(async () => ({ ...item(2), title: "New gateway" }));
    panel.client = { request: replacement } as unknown as GatewayBrowserClient;
    await expectTitle(panel, "New gateway");
    expect(request.mock.calls[1]?.[2]?.signal?.aborted).toBe(true);
    second.resolve(item(2));
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector("h1")?.textContent).toBe("New gateway");
  });

  it("clears reservations and cancels work on close, restores focus, and stays idle while hidden", async () => {
    const pending = deferredDetail();
    const request = vi.fn(
      (_method: string, _params?: unknown, _options?: { signal?: AbortSignal }) => pending.promise,
    );
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const panel = await mount(request);
    open(panel, itemUrl(1), trigger);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    expect(document.documentElement.style.getPropertyValue("--oc-link-reader-reserve-right")).toBe(
      "560px",
    );
    panel.renderRoot
      .querySelector(".lr-content")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await panel.updateComplete;
    expect(document.activeElement).toBe(trigger);
    expect(document.documentElement.style.getPropertyValue("--oc-link-reader-reserve-right")).toBe(
      "0px",
    );
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    pending.resolve(item());
    panel.available = false;
    await panel.updateComplete;
    panel.available = true;
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector(".bp")).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("suspends hidden work and resumes once, then cleans up on removal", async () => {
    const pending = deferredDetail();
    const request = vi
      .fn<
        (
          _method: string,
          _params?: unknown,
          options?: { signal?: AbortSignal },
        ) => Promise<ControlUiLinkReaderDocument>
      >()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(item());
    const panel = await mount(request);
    open(panel);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    panel.suppressed = true;
    await panel.updateComplete;
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(panel.renderRoot.querySelector(".bp")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--oc-link-reader-reserve-right")).toBe(
      "0px",
    );
    pending.resolve({ ...item(), title: "Hidden response" });
    open(panel, itemUrl(2));
    await panel.updateComplete;
    expect(request).toHaveBeenCalledTimes(1);
    panel.suppressed = false;
    await expectTitle(panel, "Item 1");
    expect(request).toHaveBeenCalledTimes(2);
    panel.remove();
    expect(document.documentElement.style.getPropertyValue("--oc-link-reader-reserve-right")).toBe(
      "0px",
    );
    window.dispatchEvent(
      new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, { detail: { url: itemUrl(2) } }),
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    "GitHub API rate limit exceeded (HTTP 403). Wait 120 seconds and retry.",
    "GitHub authentication failed (HTTP 401). Reconnect the GitHub identity in Settings.",
    "GitHub access denied (HTTP 403). Check the configured GitHub identity's repository access.",
    "GitHub item is unavailable or not public (HTTP 404). Open the link on GitHub to check access.",
    "GitHub request timed out. Retry shortly.",
  ])("shows the actionable Gateway failure: %s", async (message) => {
    const request = vi
      .fn()
      .mockRejectedValue(new GatewayRequestError({ code: "UNAVAILABLE", message }));
    const panel = await mount(request);
    open(panel);
    await waitForFast(() =>
      expect(panel.renderRoot.querySelector('[role="alert"]')?.textContent).toContain(message),
    );
    expect(panel.renderRoot.querySelector('[role="alert"] h2')?.textContent).toBe(
      "Could not load item",
    );
    expect(panel.renderRoot.querySelector('[role="alert"]')?.textContent).not.toContain(
      "This item may be private or deleted",
    );
  });

  it("keeps failure and disconnect states actionable without displaying stale content", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("not available"))
      .mockResolvedValue(item());
    const panel = await mount(request);
    open(panel);
    await waitForFast(() =>
      expect(panel.renderRoot.querySelector('[role="alert"]')?.textContent).toContain(
        "Try again or open the original",
      ),
    );
    const external = panel.renderRoot.querySelector<HTMLAnchorElement>(
      '[role="alert"] a[data-link-reader-external]',
    );
    expect(external?.href).toBe(itemUrl(1));
    expect(external?.target).toBe("_blank");
    panel.renderRoot.querySelector<HTMLButtonElement>(".lr-retry")?.click();
    await expectTitle(panel, "Item 1");
    panel.available = false;
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector("h1")).toBeNull();
    expect(panel.renderRoot.querySelector('[role="alert"]')?.textContent).toContain(
      "this connection",
    );
    expect(panel.renderRoot.querySelector<HTMLButtonElement>(".lr-retry")?.disabled).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    panel.available = true;
    await expectTitle(panel, "Item 1");
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("drops disabled plugin tabs and fences a response that resolves after removal", async () => {
    const pending = deferredDetail();
    const request = vi.fn(
      (_method: string, _params?: unknown, _options?: { signal?: AbortSignal }) => pending.promise,
    );
    const panel = await mount(request);
    open(panel);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    panel.readers = [];
    await panel.updateComplete;
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(panel.renderRoot.querySelector(".bp")).toBeNull();
    pending.resolve(item());
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector("h1")).toBeNull();
    const event = new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
      detail: { url: itemUrl(1) },
      cancelable: true,
    });
    panel.handleToggleRequest(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--oc-link-reader-reserve-right")).toBe(
      "0px",
    );
  });

  it("uses each plugin method and label, and invalidates cached data when its descriptor is replaced", async () => {
    const second: ControlUiLinkReaderDescriptor = {
      pluginId: "notes",
      id: "note",
      label: "Notes",
      linkReader: {
        hosts: ["notes.example"],
        pathPattern: "^/notes/[0-9]+$",
        detailMethod: "notes.read",
      },
    };
    const request = vi.fn(async (method: string, params?: unknown) => ({
      ...item(),
      url: (params as { url: string }).url,
      title: method,
    }));
    const panel = await mount(request);
    panel.readers = [reader, second];
    await panel.updateComplete;
    open(panel, itemUrl(1), undefined, true);
    await expectTitle(panel, "forge.item");
    open(panel, "https://notes.example/notes/2", undefined, true);
    await expectTitle(panel, "notes.read");
    expect(panel.renderRoot.querySelector(".lr-external")?.textContent).toContain("Open on Notes");
    expect(request.mock.calls[1]?.[0]).toBe("notes.read");
    panel.readers = [
      reader,
      { ...second, linkReader: { ...second.linkReader, detailMethod: "notes.readNew" } },
    ];
    await expectTitle(panel, "notes.readNew");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
