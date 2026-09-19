/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiLinkReaderDescriptor,
  ControlUiLinkReaderPreview,
} from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import { LinkReaderHovercardProvider } from "./link-reader-hovercard.ts";

const ELEMENT_NAME = "test-openclaw-link-reader-hovercard-provider-" + crypto.randomUUID();
customElements.define(ELEMENT_NAME, class extends LinkReaderHovercardProvider {});
const github: ControlUiLinkReaderDescriptor = {
  pluginId: "github",
  id: "items",
  label: "GitHub",
  linkReader: {
    hosts: ["github.com"],
    pathPattern: "^/[^/]+/[^/]+/(?:pull|issues)/[0-9]+$",
    detailMethod: "github.detail",
    previewMethod: "github.preview",
  },
};
const forge: ControlUiLinkReaderDescriptor = {
  pluginId: "forge",
  id: "changes",
  label: "Changes",
  linkReader: {
    hosts: ["forge.example"],
    pathPattern: "^/changes/[^/]+$",
    detailMethod: "forge.read",
    previewMethod: "forge.preview",
  },
};
const href = "https://github.com/openclaw/openclaw/pull/99816";
function preview(url = href): ControlUiLinkReaderPreview {
  return {
    url,
    title: "Keep previews compact",
    subtitle: "openclaw/openclaw #99816",
    badge: { label: "Merged", tone: "accent" },
    author: "reviewer",
    updatedAt: "2026-07-05T09:55:00Z",
    metadata: [
      { label: "", value: "+101" },
      { label: "", value: "−12" },
      { label: "", value: "3 files" },
    ],
    imageUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
  };
}
function createLink(url = href, readers = [github]) {
  const provider = document.createElement(ELEMENT_NAME) as LinkReaderHovercardProvider;
  provider.readers = readers;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.textContent = "Source item";
  provider.append(anchor);
  document.body.append(provider);
  return { anchor, provider };
}
function connect(
  provider: LinkReaderHovercardProvider,
  request = vi.fn().mockResolvedValue(preview()),
) {
  provider.client = { request } as unknown as GatewayBrowserClient;
  return request;
}
function card() {
  return document.querySelector<HTMLElement>(".link-reader-hovercard");
}
async function hover(anchor: HTMLAnchorElement) {
  anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
  await vi.advanceTimersByTimeAsync(250);
}
function leave(anchor: HTMLAnchorElement) {
  anchor.dispatchEvent(
    new MouseEvent("pointerout", { bubbles: true, composed: true, relatedTarget: document.body }),
  );
}

describe("openclaw-link-reader-hovercard-provider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T10:00:00Z"));
  });
  afterEach(async () => {
    await i18n.setLocale("en");
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders and caches plugin-projected details without changing the source link", async () => {
    const { anchor, provider } = createLink();
    const request = connect(provider);
    await hover(anchor);
    expect(card()?.textContent).toContain("Merged");
    expect(card()?.textContent).toContain("openclaw/openclaw #99816");
    expect(card()?.textContent).toContain("Keep previews compact");
    expect(card()?.textContent).toContain("reviewer");
    expect(card()?.textContent).toContain("+101");
    expect(card()?.textContent).toContain("−12");
    expect(card()?.textContent).toContain("3 files");
    expect(card()?.textContent).toContain("5m ago");
    expect(card()?.querySelector("img")?.src).toBe(preview().imageUrl);
    expect(anchor.href).toBe(href);
    expect(anchor.getAttribute("aria-controls")).toBe(card()?.id);
    expect(card()?.getAttribute("role")).toBe("dialog");
    expect(request).toHaveBeenCalledWith(
      "github.preview",
      { url: href },
      { signal: expect.any(AbortSignal) },
    );
    leave(anchor);
    await vi.advanceTimersByTimeAsync(120);
    expect(card()).toBeNull();
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(1);
    provider.readers = [...provider.readers];
    expect(card()).not.toBeNull();
    leave(anchor);
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("uses a second reader's method and passive DTO with keyboard focus and Escape", async () => {
    const url = "https://forge.example/changes/C42";
    const { anchor, provider } = createLink(url, [github, forge]);
    const request = connect(
      provider,
      vi.fn().mockResolvedValue({
        url,
        title: "Change C42",
        subtitle: "Team queue",
        badge: { label: "Needs review", tone: "attention" },
        author: "Alex",
        metadata: [{ label: "Comments", value: "4" }],
      }),
    );
    anchor.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(card()?.textContent).toContain("Change C42");
    expect(card()?.textContent).toContain("Comments: 4");
    expect(card()?.textContent).toContain("Needs review");
    expect(card()?.dataset.state).toBe("attention");
    expect(request).toHaveBeenCalledWith(
      "forge.preview",
      { url },
      { signal: expect.any(AbortSignal) },
    );
    anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(card()).toBeNull();
  });

  it.each([
    "https://github.com/openclaw/openclaw",
    "http://github.com/openclaw/openclaw/issues/99815",
    "https://user:secret@github.com/openclaw/openclaw/issues/99815",
    "https://example.com/openclaw/openclaw/issues/99815",
    "javascript:alert(1)",
  ])("does not preview an unsupported or unsafe URL: %s", async (url) => {
    const { anchor, provider } = createLink(url);
    const request = connect(provider);
    await hover(anchor);
    expect(request).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });

  it("accepts a preview for the requested document with a different anchor", async () => {
    const { anchor, provider } = createLink(href + "#comment-1");
    connect(provider, vi.fn().mockResolvedValue(preview(href)));
    await hover(anchor);
    expect(card()?.textContent).toContain("Keep previews compact");
  });

  it("keeps failed previews invisible and briefly caches failures", async () => {
    const { anchor, provider } = createLink();
    const request = connect(provider, vi.fn().mockRejectedValue(new Error("Not Found")));
    await hover(anchor);
    expect(card()).toBeNull();
    leave(anchor);
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(1);
    leave(anchor);
    await vi.advanceTimersByTimeAsync(30_000);
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    { title: "Wrong reader", url: "https://other.example/item/1" },
    { title: "Wrong item", url: href.replace("99816", "99817") },
    { title: "Wrong query", url: href + "?resource=other" },
  ])("rejects invalid preview data without mounting an empty popup: %j", async (value) => {
    const { anchor, provider } = createLink();
    connect(provider, vi.fn().mockResolvedValue(value));
    await hover(anchor);
    expect(card()).toBeNull();
  });

  it("preserves existing descriptions when leaving before opening and on route removal", async () => {
    const { anchor, provider } = createLink();
    const request = connect(provider);
    anchor.setAttribute("aria-describedby", "existing-description");
    anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
    leave(anchor);
    await vi.advanceTimersByTimeAsync(250);
    expect(anchor.getAttribute("aria-describedby")).toBe("existing-description");
    expect(request).not.toHaveBeenCalled();
    await hover(anchor);
    expect(anchor.getAttribute("aria-describedby")).toBe("existing-description");
    expect(anchor.getAttribute("aria-controls")).toBe(card()?.id);
    provider.replaceChildren(document.createElement("p"));
    await Promise.resolve();
    expect(card()).toBeNull();
    expect(anchor.getAttribute("aria-describedby")).toBe("existing-description");
  });

  it("removes canceled loads from cache and ignores late completions", async () => {
    const { anchor, provider } = createLink();
    const first = deferredPreview();
    const request = connect(
      provider,
      vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue({ ...preview(), title: "Current preview" }),
    );
    await hover(anchor);
    expect(card()).toBeNull();
    const signal = request.mock.calls[0]?.[2]?.signal as AbortSignal;
    leave(anchor);
    expect(signal.aborted).toBe(true);
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(2);
    expect(card()?.textContent).toContain("Current preview");
    first.resolve({ ...preview(), title: "Stale preview" });
    await vi.advanceTimersByTimeAsync(0);
    expect(card()?.textContent).not.toContain("Stale preview");
  });

  it.each(["readers", "client"] as const)(
    "hides and invalidates previews when the %s epoch changes",
    async (property) => {
      const { anchor, provider } = createLink();
      const request = connect(provider);
      await hover(anchor);
      expect(card()).not.toBeNull();
      if (property === "readers") {
        provider.readers = [];
      } else {
        provider.client = null;
      }
      expect(card()).toBeNull();
      await hover(anchor);
      expect(card()).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
      if (property === "readers") {
        provider.readers = [github];
      } else {
        connect(provider, request);
      }
      await hover(anchor);
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("replays pre-upgrade properties through the lazy provider's epoch setters", async () => {
    const tag = "test-lazy-link-reader-" + crypto.randomUUID();
    const provider = document.createElement(tag) as LinkReaderHovercardProvider;
    provider.readers = [github];
    const request = connect(provider);
    const anchor = document.createElement("a");
    anchor.href = href;
    provider.append(anchor);
    document.body.append(provider);
    customElements.define(tag, class extends LinkReaderHovercardProvider {});
    await provider.updateComplete;
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(1);
    expect(card()?.textContent).toContain("Keep previews compact");
    provider.readers = [];
    expect(card()).toBeNull();
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not request disabled previews and cancels pending requests when their descriptor is removed", async () => {
    const { anchor, provider } = createLink(href, [
      { ...github, linkReader: { ...github.linkReader, previewMethod: undefined } },
    ]);
    const pending = deferredPreview();
    const request = connect(provider, vi.fn().mockReturnValue(pending.promise));
    await hover(anchor);
    expect(request).not.toHaveBeenCalled();
    provider.readers = [github];
    await hover(anchor);
    const signal = request.mock.calls[0]?.[2]?.signal as AbortSignal;
    provider.readers = [];
    expect(signal.aborted).toBe(true);
    pending.resolve(preview());
    await vi.advanceTimersByTimeAsync(0);
    expect(card()).toBeNull();
  });

  it("expires and bounds successful preview cache entries", async () => {
    const { anchor, provider } = createLink();
    const request = connect(
      provider,
      vi
        .fn()
        .mockImplementation((_method: string, params: { url: string }) =>
          Promise.resolve(preview(params.url)),
        ),
    );
    await hover(anchor);
    leave(anchor);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(2);
    leave(anchor);
    for (let index = 1; index <= 100; index++) {
      anchor.href = "https://github.com/openclaw/openclaw/issues/" + index;
      await hover(anchor);
      leave(anchor);
    }
    anchor.href = href;
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(103);
  });

  it.each([
    "https://images.example/avatar.png",
    "https://localhost/private.png",
    "https://127.0.0.1/private.png",
    "https://host.internal/private.png",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "javascript:alert(1)",
  ])("keeps preview image requests anonymous and excludes unsafe sources: %s", async (imageUrl) => {
    const { anchor, provider } = createLink();
    connect(provider, vi.fn().mockResolvedValue({ ...preview(), imageUrl }));
    await hover(anchor);
    const image = card()?.querySelector("img");
    if (imageUrl === "https://images.example/avatar.png") {
      expect(image?.src).toBe(imageUrl);
      expect(image?.crossOrigin).toBe("anonymous");
      expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    } else {
      expect(image).toBeNull();
    }
  });

  it("rerenders host-owned preview copy when the locale changes", async () => {
    const { anchor, provider } = createLink();
    connect(provider);
    await hover(anchor);
    i18n.registerTranslation("pt-BR", {
      linkReader: {
        loadingPreview: "Carregando prévia…",
        previewAriaLabel: "Prévia: {title}",
      },
    });
    await i18n.setLocale("pt-BR");
    expect(card()?.getAttribute("aria-label")).toBe("Prévia: Keep previews compact");
    expect(card()?.textContent).toContain("Merged");
  });
});

function deferredPreview() {
  let resolve!: (value: ControlUiLinkReaderPreview) => void;
  const promise = new Promise<ControlUiLinkReaderPreview>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
