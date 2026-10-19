import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiLinkReaderDocument,
  ControlUiLinkReaderDescriptor,
} from "../../../src/shared/control-ui-link-reader.js";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { waitForSolid as waitForFast } from "../test-helpers/solid-settle.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  storageKey,
  itemUrl,
  reader,
  item,
  requestedItem,
  deferredDetail,
  mount,
  open,
  button,
  expectTitle,
} from "./link-reader-panel.test-support.ts";
import "./link-reader-panel.tsx";
import { LINK_READER_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";

describe("Plugin link reader panel", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    // Section selection owns these requests; no viewport preload is admitted here.
    vi.stubGlobal(
      "IntersectionObserver",
      class extends IntersectionObserver {
        override observe() {}
      },
    );
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("shows the overview while independent sections wait and loads files on selection", async () => {
    const overview = deferredDetail();
    const checks = deferredDetail();
    const discussion = deferredDetail();
    const files = deferredDetail();
    const request = vi.fn((_method: string, params?: unknown) => {
      const section = (params as { section: string }).section;
      return ({ overview, checks, discussion, files }[section] ?? overview).promise;
    });
    const panel = await mount(request);
    const scrollPorts = new Set<HTMLElement>();
    panel.onScrollPortRef = (element) => {
      scrollPorts.add(element);
      return () => {
        scrollPorts.delete(element);
      };
    };
    panel.readers = [{ ...reader, linkReader: { ...reader.linkReader, progressive: true } }];
    await panel.updateComplete;
    open(panel);
    await waitForFast(() => expect(panel.querySelector(".lr-skeleton")).not.toBeNull());
    overview.resolve({
      ...item(),
      comments: undefined,
      revision: "head-a",
      deferredSections: ["checks", "files", "discussion"],
      filesTotal: 13,
    });
    await expectTitle(panel, "Item 1");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    expect(panel.textContent).toContain("Description");
    expect(panel.textContent).not.toContain("No comments yet");
    expect(panel.querySelector(".lr-checks--pending")).toBeNull();
    discussion.resolve({ ...item(), revision: "head-a" });
    await waitForFast(() =>
      expect(panel.querySelector(".lr-comment")?.textContent).toContain("Comment text"),
    );
    const filesButton = [
      ...panel.querySelectorAll<HTMLButtonElement>(".lr-section-nav button"),
    ].find((node) => node.textContent?.includes("Files"))!;
    const deferredFiles = panel.querySelector('[data-reader-section="files"]');
    filesButton.click();
    expect(document.activeElement).toBe(deferredFiles);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));
    files.resolve({
      ...item(),
      revision: "head-a",
      files: [{ path: "index.ts", additions: 1, deletions: 0, patch: "+new" }],
    });
    await waitForFast(() =>
      expect(panel.querySelector(".lr-file")?.textContent).toContain("index.ts"),
    );
    const loadedFiles = panel.querySelector(".lr-files");
    expect(scrollPorts.has(panel.querySelector(".lr-content")!)).toBe(true);
    expect(scrollPorts.has(panel.querySelector(".lr-diff")!)).toBe(true);
    expect(deferredFiles?.isConnected).toBe(false);
    filesButton.click();
    expect(document.activeElement).toBe(loadedFiles);
    checks.resolve({
      ...item(),
      revision: "head-b",
      checks: {
        state: "success",
        summary: "Wrong head passed",
        total: 1,
        items: [{ name: "Build", state: "success" }],
      },
    });
    await waitForFast(() => expect(panel.textContent).toContain("This item changed"));
    expect(panel.textContent).not.toContain("Wrong head passed");
    panel.remove();
    await waitForFast(() => expect(scrollPorts.size).toBe(0));
  });

  it.each(["checks", "files", "discussion"] as const)(
    "retains previous %s when an upstream failure is normalized to empty partial data",
    async (section) => {
      const previous: ControlUiLinkReaderDocument = {
        ...item(),
        revision: "head-a",
        checks: {
          state: "success",
          summary: "Build passed",
          total: 1,
          items: [{ name: "Build", state: "success" }],
        },
        files: [{ path: "kept.ts", additions: 1, deletions: 0 }],
      };
      const overview: ControlUiLinkReaderDocument = {
        ...item(),
        revision: "head-a",
        comments: undefined,
        deferredSections: [section],
      };
      const failed: ControlUiLinkReaderDocument = {
        ...overview,
        checks: {
          state: "unavailable",
          summary: "Checks unavailable",
          total: 0,
          items: [],
          truncated: true,
        },
        files: [],
        filesTruncated: true,
        comments: [],
        commentsTruncated: true,
      };
      const request = vi
        .fn()
        .mockResolvedValueOnce(previous)
        .mockResolvedValueOnce(overview)
        .mockResolvedValueOnce(failed);
      const panel = await mount(request);
      panel.readers = [{ ...reader, linkReader: { ...reader.linkReader, progressive: true } }];
      open(panel);
      await expectTitle(panel, "Item 1");
      button(panel, "Refresh item").click();
      await waitForFast(() => expect(panel.textContent).toContain("Could not refresh"));
      expect(panel.textContent).toContain(
        section === "checks" ? "Build passed" : section === "files" ? "kept.ts" : "Comment text",
      );
      request.mockResolvedValueOnce(previous);
      const name =
        section === "discussion" ? "Discussion" : section === "checks" ? "Checks" : "Files";
      [...panel.querySelectorAll<HTMLButtonElement>(".lr-section-nav button")]
        .find((node) => node.textContent?.startsWith(name))!
        .click();
      await waitForFast(() => expect(panel.textContent).not.toContain("Could not refresh"));
      expect(request).toHaveBeenCalledTimes(4);
      expect(request).toHaveBeenLastCalledWith(
        "forge.item",
        expect.objectContaining({ section, refresh: true }),
        expect.anything(),
      );
    },
  );

  it("retains the document during refresh and retryable failure, but clears it on access loss", async () => {
    let reject!: (error: Error) => void;
    const refresh = new Promise((_resolve, fail) => {
      reject = fail;
    });
    const request = vi.fn().mockResolvedValueOnce(item()).mockReturnValueOnce(refresh);
    const panel = await mount(request);
    open(panel);
    await expectTitle(panel, "Item 1");
    const document = panel.querySelector(".lr-document");
    button(panel, "Refresh item").click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(panel.querySelector(".lr-document")).toBe(document);
    expect(panel.textContent).toContain("Showing previous details");
    reject(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Temporary failure",
        retryable: true,
      }),
    );
    await waitForFast(() => expect(panel.textContent).toContain("Temporary failure"));
    expect(panel.querySelector(".lr-document")).toBe(document);
    // A changed identity or denied repository must never keep admitted pixels.
    request.mockRejectedValueOnce(
      new GatewayRequestError({ code: "UNAVAILABLE", message: "Access denied", retryable: false }),
    );
    button(panel, "Refresh item").click();
    await waitForFast(() => expect(panel.querySelector("h1")).toBeNull());
    expect(panel.textContent).toContain("Access denied");
  });

  it.each([
    ["Merged", "accent", "2026-09-23T12:31:58Z"],
    ["Closed", "negative", "2026-09-24T09:15:00Z"],
    ["Open", "positive", undefined],
    ["Draft", "neutral", undefined],
  ] as const)("shows the %s event date beside its badge", async (label, tone, timestamp) => {
    const document = {
      ...item(),
      createdAt: "2026-09-23T11:08:47Z",
      updatedAt: "2026-09-25T01:00:00Z",
      badge: { label, tone, timestamp },
    };
    const panel = await mount(vi.fn().mockResolvedValue(document));
    open(panel);
    await expectTitle(panel, document.title);
    const time = panel.querySelector(".lr-content:not([hidden]) time");
    const expected = timestamp ?? document.createdAt;
    expect(time?.getAttribute("datetime")).toBe(expected);
    expect(time?.textContent?.trim()).toBe(new Date(expected).toLocaleString());
    expect(panel.querySelector(".lr-state")?.textContent?.trim()).toBe(label);
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
      expect([...panel.querySelectorAll("img")].map((image) => image.src)).toEqual([
        dataUrl,
        dataUrl,
      ]),
    );
    expect(request.mock.calls.filter(([method]) => method === "forge.image")).toHaveLength(1);
    expect(panel.querySelector<HTMLAnchorElement>(".lr-image a")?.href).toBe(url);
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
    const oldImage = panel.querySelector("img")!;
    expect(oldImage.hasAttribute("src")).toBe(false);
    panel.client = {
      request: vi.fn().mockResolvedValue(item()),
    } as unknown as GatewayBrowserClient;
    await panel.updateComplete;
    expect(imageSignal?.aborted).toBe(true);
    finish({ url, dataUrl: "data:image/png;base64,aW1hZ2U=" });
    await expectTitle(panel, "Item 1");
    expect(oldImage.hasAttribute("src")).toBe(false);
    expect(panel.querySelector("img")).toBeNull();
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
      await waitForFast(() => expect(panel.querySelector("img")?.src).toBe(url));
      expect(panel.querySelector("img")?.crossOrigin).toBe("anonymous");
      expect(panel.querySelector<HTMLAnchorElement>(".lr-image a")?.href).toBe(url);
    },
  );

  it.each([false, true])(
    "preserves typing focus while opening and settling a reader (embedded: %s)",
    async (embedded) => {
      const composer = document.createElement("textarea");
      document.body.append(composer);
      composer.focus();
      const pending = deferredDetail();
      const request = vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockRejectedValueOnce(new Error("Request failed"));
      const panel = await mount(request, { embedded, presented: embedded });
      expect(document.activeElement).toBe(composer);

      open(panel, itemUrl(1) + "#comment-4");
      await panel.updateComplete;
      expect(request).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(composer);
      pending.resolve(item());
      await pending.promise;
      await panel.updateComplete;
      expect(panel.querySelector("h1")?.textContent).toBe("Item 1");
      expect(document.activeElement).toBe(composer);

      open(panel, itemUrl(2));
      await panel.updateComplete;
      await panel.updateComplete;
      await waitForFast(() =>
        expect(panel.querySelector('[role="alert"] h2')?.textContent).toBe("Could not load item"),
      );
      expect(document.activeElement).toBe(composer);
      const address = panel.querySelector<HTMLInputElement>(".lr-url")!;
      address.focus();
      address.value = itemUrl(3);
      address.dispatchEvent(new Event("input", { bubbles: true }));
      await panel.updateComplete;
      expect(document.activeElement).toBe(address);
    },
  );

  it.each([itemUrl(2), itemUrl(1) + "?resource=other"])(
    "rejects a document for another target: %s",
    async (url) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce({ ...item(2), url })
        .mockResolvedValueOnce(item(1));
      const panel = await mount(request);
      open(panel);
      await waitForFast(() => expect(panel.querySelector(".lr-retry")).not.toBeNull());
      expect(panel.querySelector("h1")).toBeNull();
      panel.querySelector<HTMLButtonElement>(".lr-retry")?.click();
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
    expect(second.querySelector("h1")).toBeNull();
    expect(first.querySelector(".bp--embedded")).not.toBeNull();
    expect(first.querySelector("resizable-divider")).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();

    const standalone = await mount(request);
    open(standalone, itemUrl(2));
    await expectTitle(standalone, "Item 2");
    first.tabsInHeader = !first.tabsInHeader;
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
    const content = panel.querySelector(".lr-content");
    panel.presented = false;
    await panel.updateComplete;
    open(panel, itemUrl(3));
    panel.presented = true;
    await panel.updateComplete;
    expect(panel.querySelector(".lr-content")).toBe(content);
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
    expect(panel.querySelector("h1")).toBeNull();
    expect(button(panel, "Back").disabled).toBe(true);
    expect(panel.querySelector<HTMLInputElement>(".lr-url")?.value).toBe("");
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
    expect(panel.querySelector(".lr-tab-header")).toBeNull();
    expect(panel.hostedTabs).toMatchObject([{ label: "Item 1", url: itemUrl(1) }]);
    const actions = panel.hostedActions!;
    const header = document.body.appendChild(document.createElement("header"));
    header.append(actions);
    const newTab = actions.querySelector<HTMLButtonElement>("button")!;
    newTab.focus();
    panel.available = false;
    await panel.updateComplete;
    expect(newTab.disabled).toBe(true);
    panel.available = true;
    await panel.updateComplete;
    expect(panel.hostedActions).toBe(actions);
    expect(actions.querySelector("button")).toBe(newTab);
    expect(newTab.disabled).toBe(false);
    newTab.click();
    await panel.updateComplete;
    expect(panel.hostedTabs).toHaveLength(2);
    await panel.closeHostedTab(panel.activeHostedTabId!);
    panel.tabsInHeader = false;
    await panel.updateComplete;
    expect(panel.querySelector(".lr-tab-header")).not.toBeNull();
    await panel.closeHostedTab(panel.activeHostedTabId!);
    expect(onClose).toHaveBeenCalledOnce();
    expect(panel.hostedTabs).toEqual([]);
    expect(panel.querySelector(".link-reader-panel")).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
    panel.remove();
    await Promise.resolve();
    expect(header.childElementCount).toBe(0);
  });

  it("carries only the current session into a session-scoped detail reader", async () => {
    const request = vi.fn(async (_method: string, params?: unknown) => requestedItem(params));
    const panel = await mount(request, { sessionKey: "agent:main:private" });
    panel.readers = [{ ...reader, linkReader: { ...reader.linkReader, sessionScoped: true } }];
    open(panel);
    await expectTitle(panel, "Item 1");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ sessionKey: "agent:main:private" });
  });

  it("loads only an explicitly selected item and persists layout, not content or history", async () => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ open: true, dock: "right", width: 560, height: 420 }),
    );
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
    expect(request).not.toHaveBeenCalled();
    expect(panel.querySelector(".bp")).toBeNull();
    open(panel);
    await expectTitle(panel, "Item 1");
    expect(request).toHaveBeenCalledWith(
      "forge.item",
      { url: itemUrl(1), agentId: "selected-agent" },
      { signal: expect.any(AbortSignal) },
    );
    expect(panel.querySelector(".lr-description strong")?.textContent).toBe("Description");
    expect(panel.querySelector(".lr-comment")?.textContent).toContain("Comment text");
    expect(panel.querySelector(".lr-files")).toBeNull();
    expect(panel.querySelector(".lr-state")?.textContent).toBe("Open");
    expect(panel.querySelector("time")?.dateTime).toBe("2026-09-01T12:00:00Z");
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
    const request = vi.fn(async (_method: string, params: unknown) => ({
      ...requestedItem(params),
      files: [{ path: "src/example.ts", additions: 1, deletions: 1, patch: "-old\n+new" }],
    }));
    const panel = await mount(request);
    open(panel, itemUrl(1), undefined, true);
    await expectTitle(panel, "Item 1");
    const firstContent = panel.querySelector(".lr-content");
    const firstFile = firstContent!.querySelector<HTMLDetailsElement>(".lr-file")!;
    firstFile.open = true;
    open(panel, itemUrl(2), undefined, true);
    await expectTitle(panel, "Item 2");
    expect(panel.querySelectorAll(".tabstrip-tab")).toHaveLength(2);
    expect(panel.querySelectorAll(".tabstrip-tab__icon svg")).toHaveLength(2);
    const hostedTabs = panel.hostedTabs;
    expect(hostedTabs.every((tab) => tab.icon instanceof SVGSVGElement)).toBe(true);
    expect(hostedTabs[0]!.icon).not.toBe(panel.hostedTabs[0]!.icon);
    open(panel, itemUrl(1), undefined, true);
    await expectTitle(panel, "Item 1");
    expect(panel.querySelectorAll(".tabstrip-tab")).toHaveLength(2);
    expect(panel.querySelector(".lr-content:not([hidden])")).toBe(firstContent);
    expect(firstContent!.querySelector(".lr-file")).toBe(firstFile);
    expect(firstFile.open).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(panel.querySelector<HTMLAnchorElement>(".lr-external")?.href).toBe(itemUrl(1));
    panel.querySelectorAll<HTMLButtonElement>(".tabstrip-tab__close")[1]?.click();
    await panel.updateComplete;
    await expectTitle(panel, "Item 1");
    expect(panel.querySelectorAll(".tabstrip-tab")).toHaveLength(1);
    panel.querySelector<HTMLButtonElement>(".tabstrip-tab__close")?.click();
    await panel.updateComplete;
    expect(panel.querySelector(".link-reader-panel")).toBeNull();
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
    expect(panel.querySelectorAll(".tabstrip-tab")).toHaveLength(10);
    await expectTitle(panel, "Item 10");
    expect(request).toHaveBeenCalledTimes(calls);
    expect(panel.querySelector<HTMLAnchorElement>('.lr-note[role="alert"] a')?.href).toBe(
      itemUrl(11),
    );
  });

  it("validates the new-tab address bar before requesting a document", async () => {
    const request = vi.fn(async (_method: string, params: unknown) => requestedItem(params));
    const panel = await mount(request);
    open(panel);
    await expectTitle(panel, "Item 1");
    panel.querySelector<HTMLButtonElement>(".tabstrip-new")?.click();
    await panel.updateComplete;
    const input = panel.querySelector<HTMLInputElement>(".lr-url")!;
    expect(document.activeElement).toBe(input);
    const form = panel.querySelector("form")!;
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
    panel
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
    expect(panel.querySelector(".bp")).toBeNull();
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
    expect(panel.querySelector(".bp")).toBeNull();
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
    await Promise.resolve();
    expect(document.documentElement.style.getPropertyValue("--oc-link-reader-reserve-right")).toBe(
      "0px",
    );
    window.dispatchEvent(
      new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, { detail: { url: itemUrl(2) } }),
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      error: new Error("not available"),
      message: "Try again or open the original",
    },
    {
      error: new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "GitHub API rate limit exceeded (HTTP 403). Wait 120 seconds and retry.",
      }),
      message: "GitHub API rate limit exceeded (HTTP 403). Wait 120 seconds and retry.",
    },
  ])("keeps failure and disconnect states actionable: $message", async ({ error, message }) => {
    const request = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(item());
    const panel = await mount(request);
    open(panel);
    await waitForFast(() =>
      expect(panel.querySelector('[role="alert"]')?.textContent).toContain(message),
    );
    expect(panel.querySelector('[role="alert"] h2')?.textContent).toBe("Could not load item");
    expect(panel.querySelector('[role="alert"]')?.textContent).not.toContain(
      "This item may be private or deleted",
    );
    const external = panel.querySelector<HTMLAnchorElement>(
      '[role="alert"] a[data-link-reader-external]',
    );
    expect(external?.href).toBe(itemUrl(1));
    expect(external?.target).toBe("_blank");
    panel.querySelector<HTMLButtonElement>(".lr-retry")?.click();
    await expectTitle(panel, "Item 1");
    panel.available = false;
    await panel.updateComplete;
    expect(panel.querySelector("h1")?.textContent).toBe("Item 1");
    expect(button(panel, "Refresh item").disabled).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    panel.available = true;
    await expectTitle(panel, "Item 1");
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("retains the loaded document, selected tab, and address draft through a transport blip", async () => {
    const refreshed = deferredDetail();
    const request = vi.fn().mockResolvedValueOnce(item()).mockReturnValueOnce(refreshed.promise);
    const panel = await mount(request);
    open(panel);
    await expectTitle(panel, "Item 1");
    const address = panel.querySelector<HTMLInputElement>(".lr-url")!;
    address.value = "https://forge.example/items/42";
    address.dispatchEvent(new Event("input", { bubbles: true }));
    const selected = panel.activeHostedTabId;
    const document = panel.querySelector("h1");

    panel.available = false;
    await panel.updateComplete;
    expect(panel.querySelector("h1")).toBe(document);
    expect(address.value).toBe("https://forge.example/items/42");
    expect(panel.activeHostedTabId).toBe(selected);
    expect(panel.querySelector<HTMLButtonElement>(".lr-go")?.disabled).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);

    panel.available = true;
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(panel.querySelector("h1")).toBe(document);
    expect(address.value).toBe("https://forge.example/items/42");
    refreshed.resolve({ ...item(), title: "Refreshed item" });
    await expectTitle(panel, "Refreshed item");

    const replacement = deferredDetail();
    panel.client = {
      request: vi.fn().mockReturnValue(replacement.promise),
    } as unknown as GatewayBrowserClient;
    await panel.updateComplete;
    expect(panel.querySelector("h1")).toBeNull();
    replacement.resolve({ ...item(), title: "Replacement identity" });
    await expectTitle(panel, "Replacement identity");
  });
  it("refreshes retained tabs and their images when selected after reconnect, including interrupted catch-up", async () => {
    const imageUrl = "https://images.example/document.png";
    const oldImage = "data:image/png;base64,b2xk";
    const freshImage = "data:image/png;base64,bmV3";
    const interrupted = deferredDetail();
    let refreshed = false;
    let delayFirstRefresh = true;
    let generation = 1;
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "forge.image") {
        return Promise.resolve({ url: imageUrl, dataUrl: refreshed ? freshImage : oldImage });
      }
      const document = requestedItem(params);
      if (refreshed && document.url === itemUrl(1) && delayFirstRefresh) {
        delayFirstRefresh = false;
        return interrupted.promise;
      }
      return Promise.resolve({
        ...document,
        title: refreshed ? "Fresh " + document.title : document.title,
        body: `![Document image](${imageUrl})`,
      });
    });
    const panel = await mount(request);
    Object.defineProperty(panel.client, "connectionGeneration", { get: () => generation });
    panel.readers = [
      { ...reader, linkReader: { ...reader.linkReader, imageMethod: "forge.image" } },
    ];
    await panel.updateComplete;
    open(panel);
    await expectTitle(panel, "Item 1");
    const firstTab = panel.activeHostedTabId!;
    await waitForFast(() => expect(panel.querySelector("img")?.src).toBe(oldImage));
    open(panel, itemUrl(2), undefined, true);
    await expectTitle(panel, "Item 2");
    const secondTab = panel.activeHostedTabId!;

    panel.available = false;
    generation++;
    await panel.updateComplete;
    expect(panel.querySelector(".lr-content:not([hidden]) h1")?.textContent).toBe("Item 2");
    refreshed = true;
    panel.available = true;
    await expectTitle(panel, "Fresh Item 2");

    panel.selectHostedTab(firstTab);
    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === "forge.item")).toHaveLength(4),
    );
    expect(panel.querySelector(".lr-content:not([hidden]) h1")?.textContent).toBe("Item 1");
    panel.selectHostedTab(secondTab);
    await expectTitle(panel, "Fresh Item 2");
    interrupted.resolve({ ...item(), title: "Obsolete refresh" });
    await interrupted.promise;
    await panel.updateComplete;
    expect(panel.querySelector(".lr-content:not([hidden]) h1")?.textContent).toBe("Fresh Item 2");

    panel.selectHostedTab(firstTab);
    await expectTitle(panel, "Fresh Item 1");
    await waitForFast(() =>
      expect(panel.querySelector<HTMLImageElement>(".lr-content:not([hidden]) img")?.src).toBe(
        freshImage,
      ),
    );
  });
  it("retires loaded documents and images when offline recovery is revoked on the same client", async () => {
    const loadedUrl = "https://images.example/loaded.png";
    const pendingUrl = "https://images.example/pending.png";
    const dataUrl = "data:image/png;base64,aW1hZ2U=";
    const pending = createDeferred<{ url: string; dataUrl: string }>();
    const imageRequest = vi
      .fn<
        (
          _params: unknown,
          options?: { signal?: AbortSignal },
        ) => Promise<{
          url: string;
          dataUrl: string;
        }>
      >()
      .mockResolvedValueOnce({ url: loadedUrl, dataUrl })
      .mockReturnValue(pending.promise);
    const panel = await mount((method, params, options) =>
      method === "forge.image"
        ? imageRequest(params, options)
        : Promise.resolve({
            ...item(),
            body: `![Loaded](${loadedUrl})\n\n![Pending](${pendingUrl})`,
          }),
    );
    panel.readers = [
      { ...reader, linkReader: { ...reader.linkReader, imageMethod: "forge.image" } },
    ];
    await panel.updateComplete;
    open(panel);
    await waitForFast(() => expect(imageRequest).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(panel.querySelector("img")?.src).toBe(dataUrl));
    const title = panel.querySelector("h1");
    const image = panel.querySelector("img");
    const imageSignal = imageRequest.mock.calls[1]?.[1]?.signal;
    expect(imageSignal?.aborted).toBe(false);

    panel.available = false;
    await panel.updateComplete;
    expect(panel.querySelector("h1")).toBe(title);
    expect(panel.querySelector("img")).toBe(image);
    expect(imageSignal?.aborted).toBe(false);

    Object.defineProperty(panel.client, "offlineRecoveryRetired", { value: true });
    panel.readers = [];
    await panel.updateComplete;
    expect(imageSignal?.aborted).toBe(true);
    expect(panel.hostedTabs).toEqual([]);
    expect(panel.querySelector("h1")).toBeNull();
    expect(panel.querySelector("img")).toBeNull();
    expect(image?.isConnected).toBe(false);

    pending.resolve({ url: pendingUrl, dataUrl });
    await pending.promise;
    await panel.updateComplete;
    expect(panel.querySelector("h1")).toBeNull();
    expect(panel.querySelector("img")).toBeNull();
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
    expect(panel.querySelector(".bp")).toBeNull();
    pending.resolve(item());
    await panel.updateComplete;
    expect(panel.querySelector("h1")).toBeNull();
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
    expect(panel.querySelector(".lr-external")?.textContent).toContain("Open on Notes");
    expect(request.mock.calls[1]?.[0]).toBe("notes.read");
    panel.readers = [
      reader,
      { ...second, linkReader: { ...second.linkReader, detailMethod: "notes.readNew" } },
    ];
    await expectTitle(panel, "notes.readNew");
    expect(request).toHaveBeenCalledTimes(3);
  });
});
