/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { LinkReaderHovercardProvider as LinkHovercardProvider } from "./link-reader-hovercard.ts";
import {
  LINK_READER_HOVERCARD_PROVIDER_TAG as LINK_HOVERCARD_TAG,
  resolveHoverPreviewTarget,
} from "./link-reader-target.ts";

function linkHovercardUrl(anchor: HTMLAnchorElement) {
  const owner = anchor.closest<LinkHovercardProvider>(LINK_HOVERCARD_TAG)!;
  const target = resolveHoverPreviewTarget(anchor, owner);
  return target && !target.reader ? new URL(target.href) : null;
}
import { prefetchLinkReader } from "./link-reader-prefetch-request.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { installTitleTooltips } from "./tooltip-title.ts";
import { renderWizardStepControls } from "./wizard-step-controls.ts";

if (!customElements.get(LINK_HOVERCARD_TAG)) {
  customElements.define(LINK_HOVERCARD_TAG, LinkHovercardProvider);
}
const url = "https://example.com/guide#chapter";
function fixture(shadow = false) {
  const request = vi
    .fn()
    .mockResolvedValue({ title: "Field guide", description: "A practical introduction" });
  const client = { request, connected: true, connectionGeneration: 1, recoveryScope: "first" };
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const context = {
    gateway: {
      snapshot: {
        client,
        phase: "connected",
        hello: { auth: { role: "operator", scopes: ["operator.read"] } },
      },
      subscribe,
    },
    config: { current: { automaticallyFetchFavicons: true }, subscribe },
  };
  const provider = document.createElement(LINK_HOVERCARD_TAG) as LinkHovercardProvider;
  provider.pagePreviewContext = context as unknown as ApplicationContext;
  provider.client = client as unknown as GatewayBrowserClient;
  provider.readers = [
    {
      pluginId: "forge",
      id: "items",
      label: "Forge",
      linkReader: {
        hosts: ["github.com"],
        pathPattern: "^/[^/]+/[^/]+/(pull|issues)/[0-9]+$",
        detailMethod: "forge.detail",
        previewMethod: "forge.preview",
      },
    },
  ];
  const pane = provider.appendChild(document.createElement("section"));
  const root = shadow ? pane.attachShadow({ mode: "open" }) : pane;
  const anchor = root.appendChild(document.createElement("a"));
  anchor.href = url;
  anchor.textContent = "Read the guide";
  document.body.append(provider);
  return {
    provider,
    pane,
    anchor,
    request,
    context,
    client,
    notify: () => listeners.forEach((listener) => listener()),
  };
}
function card() {
  return document.querySelector<HTMLElement>(".link-hovercard");
}
async function hover(anchor: HTMLElement) {
  anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
  await vi.advanceTimersByTimeAsync(250);
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("generic link hovercards", () => {
  it("keeps a rendered GitHub sign-in link ordinary while genuine issue and PR links preview", async () => {
    const view = fixture();
    const login = "https://github.com/login?return_to=%2Facme%2Fproject%2Fpull%2F42";
    view.pane.innerHTML = toSanitizedMarkdownHtml(
      `[Sign in](${login}) · [Pull request](https://github.com/acme/project/pull/42) · [Issue](https://github.com/acme/project/issues/43)`,
    );
    const [signIn, pull, issue] = view.pane.querySelectorAll<HTMLAnchorElement>("a");
    await hover(signIn!);
    signIn!.focus();
    signIn!.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    await vi.advanceTimersByTimeAsync(300);
    await prefetchLinkReader(signIn!, new AbortController().signal);
    expect(view.request).not.toHaveBeenCalled();
    expect(document.querySelector(".link-hovercard, .link-reader-hovercard")).toBeNull();
    expect(signIn!.href).toBe(login);
    expect(signIn!.target).toBe("_blank");
    expect(signIn!.textContent).toBe("Sign in");
    for (const anchor of [pull!, issue!]) {
      view.request.mockResolvedValue({
        url: anchor.href,
        title: "Real resource",
        subtitle: "acme/project",
        badge: { label: "Open", tone: "positive" },
      });
      await hover(anchor);
      expect(document.querySelector(".link-reader-hovercard")?.textContent).toContain(
        "Real resource",
      );
      expect(view.request).toHaveBeenLastCalledWith(
        "forge.preview",
        { url: anchor.href },
        { signal: expect.any(AbortSignal) },
      );
    }
  });

  it.each([
    "https://github.com/",
    "https://github.com/acme",
    "https://github.com/acme/project",
    "https://github.com/login/oauth/authorize?client_id=example-client",
    "https://github.com/session",
    "https://www.github.com/login",
  ])("never substitutes a public-page card for unsupported GitHub URL %s", async (href) => {
    const view = fixture();
    view.anchor.href = href;
    await hover(view.anchor);
    expect(view.request).not.toHaveBeenCalled();
    expect(card()).toBeNull();
    expect(view.anchor.href).toBe(href);
  });

  it("leaves the real wizard sign-in action external without fetching its authorization URL", async () => {
    const view = fixture();
    const authorizationUrl = "https://provider.example/authorize?state=synthetic-state";
    render(
      renderWizardStepControls({
        step: {
          id: "sign-in",
          type: "progress",
          executor: "gateway",
          externalUrl: authorizationUrl,
        },
        value: undefined,
        busy: false,
        inputId: "sign-in",
        onValueChange: () => {},
        onAnswer: () => {},
      }),
      view.pane,
    );
    const signIn = view.pane.querySelector<HTMLAnchorElement>(".wizard-step__external-link")!;
    await hover(signIn);
    signIn.focus();
    signIn.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    await vi.advanceTimersByTimeAsync(1);
    expect(view.request).not.toHaveBeenCalled();
    expect(card()).toBeNull();
    expect(signIn.href).toBe(authorizationUrl);
    expect(signIn.target).toBe("_blank");
    await hover(view.anchor);
    expect(card()?.textContent).toContain("Field guide");
  });
  it("does not prefetch ordinary links or consume a detail-only plugin claim", async () => {
    const view = fixture();
    await prefetchLinkReader(view.anchor, new AbortController().signal);
    expect(view.request).not.toHaveBeenCalled();
    view.provider.claimedReaders = [
      {
        pluginId: "forge",
        id: "commits",
        label: "Commits",
        linkReader: {
          hosts: ["example.com"],
          pathPattern: "^/guide$",
          detailMethod: "forge.detail",
        },
      },
    ];
    await hover(view.anchor);
    expect(view.request).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });

  it("does not unlock plugin loading hints after a public page succeeds", async () => {
    const view = fixture();
    await hover(view.anchor);
    expect(card()).not.toBeNull();
    const pending = createDeferred<unknown>();
    view.request.mockReturnValue(pending.promise);
    view.anchor.href = "https://github.com/openclaw/openclaw/pull/42";
    await hover(view.anchor);
    expect(card()).toBeNull();
    expect(document.querySelector(".link-reader-hovercard")).toBeNull();
    pending.reject(new Error("Unavailable"));
    await vi.advanceTimersByTimeAsync(1);
  });

  it("retires a visible page when its anchor becomes a file or plugin-owned link", async () => {
    const view = fixture();
    await hover(view.anchor);
    view.anchor.setAttribute("data-file-path", "/guide");
    await vi.advanceTimersByTimeAsync(1);
    expect(card()).toBeNull();
  });
  it("opens after intent, shares metadata, preserves href and crosses the pointer gap", async () => {
    const view = fixture();
    await hover(view.anchor);
    expect(card()?.textContent).toContain("Field guide");
    expect(card()?.textContent).toContain("A practical introduction");
    expect(card()?.querySelector("a")?.getAttribute("href")).toBe(url);
    expect(view.anchor.href).toBe(url);
    view.anchor.dispatchEvent(
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    );
    card()!.dispatchEvent(new MouseEvent("pointerenter"));
    await vi.advanceTimersByTimeAsync(250);
    expect(card()).not.toBeNull();
    card()!.dispatchEvent(new MouseEvent("pointerleave"));
    await vi.advanceTimersByTimeAsync(150);
    expect(card()).toBeNull();
    await hover(view.anchor);
    expect(view.request).toHaveBeenCalledOnce();
  });

  it("cancels a short hover before fetching", async () => {
    const view = fixture();
    view.anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    view.anchor.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(view.request).not.toHaveBeenCalled();
    expect(card()).toBeNull();
    expect(view.anchor.hasAttribute("aria-haspopup")).toBe(false);
  });

  it.each(["config", "client", "generation", "scope", "href", "removed", "hidden"])(
    "retires pending metadata when %s changes",
    async (change) => {
      const view = fixture();
      const pending = createDeferred<unknown>();
      view.request.mockReturnValue(pending.promise);
      await hover(view.anchor);
      expect(card()).not.toBeNull();
      if (change === "config") {
        view.context.config.current.automaticallyFetchFavicons = false;
      }
      if (change === "client") {
        view.context.gateway.snapshot.client = { ...view.client };
      }
      if (change === "generation") {
        view.client.connectionGeneration++;
      }
      if (change === "scope") {
        view.client.recoveryScope = "next";
      }
      if (change === "href") {
        view.anchor.href = "https://example.org/other";
      }
      if (change === "removed") {
        view.pane.remove();
      }
      if (change === "hidden") {
        view.pane.hidden = true;
      }
      view.notify();
      pending.resolve({ title: "Obsolete" });
      await vi.advanceTimersByTimeAsync(1);
      expect(card()).toBeNull();
      expect(view.anchor.hasAttribute("aria-controls")).toBe(false);
    },
  );

  it("keeps fallback usable on failure and hides broken images", async () => {
    const view = fixture();
    view.request.mockResolvedValue({
      imageDataUrl: "data:image/png;base64,AAAA",
      faviconDataUrl: "data:image/png;base64,AAAA",
    });
    await hover(view.anchor);
    expect(card()?.textContent).toContain("Read the guide");
    for (const image of card()!.querySelectorAll("img")) {
      image.dispatchEvent(new Event("error"));
    }
    expect(card()?.querySelectorAll("img").length).toBe(0);
    expect(card()?.querySelector("a")?.target).toBe("_blank");
  });

  it("supports shadow-root links, keyboard traversal and Escape without reopening", async () => {
    const view = fixture(true);
    view.anchor.focus();
    view.provider.activateFromBootstrap(
      view.anchor,
      resolveHoverPreviewTarget(view.anchor, view.provider)!,
      "focus",
      0,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(card()).not.toBeNull();
    view.anchor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(card()?.querySelector("a"));
    card()!
      .querySelector("a")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    await vi.advanceTimersByTimeAsync(1);
    expect(card()).toBeNull();
    expect(view.anchor.matches(":focus")).toBe(true);
  });

  it("reserves title hints without losing an icon-only accessible name", async () => {
    const stop = installTitleTooltips(document);
    try {
      const view = fixture();
      view.anchor.textContent = "";
      view.anchor.title = "Guide details";
      await hover(view.anchor);
      expect(view.anchor.getAttribute("aria-label")).toBe("Guide details");
      expect(view.anchor.title).toBe("");
      expect(document.querySelector("openclaw-tooltip")?.textContent ?? "").toBe("");
    } finally {
      stop();
    }
  });

  it("leaves touch and disabled fetching alone", async () => {
    const view = fixture();
    const touch = new MouseEvent("pointerover", { bubbles: true });
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    view.anchor.dispatchEvent(touch);
    await vi.advanceTimersByTimeAsync(300);
    expect(card()).toBeNull();
    view.context.config.current.automaticallyFetchFavicons = false;
    await hover(view.anchor);
    expect(view.request).not.toHaveBeenCalled();
  });

  it.each([
    "https://github.com/openclaw/openclaw/pull/42",
    "https://github.com/openclaw/openclaw/issues/42",
    "/chat/main",
    "#section",
    "mailto:hello@example.com",
    "file:///guide",
    "https://user:pass@example.com/",
  ])("keeps specialized or non-web URL %s with its owner", (href) => {
    const { anchor } = fixture();
    anchor.href = href;
    expect(linkHovercardUrl(anchor)).toBeNull();
  });
  it.each(["download", "data-file-path", "data-session-href", "data-link-reader-external"])(
    "excludes %s anchors",
    (attribute) => {
      const { anchor } = fixture();
      anchor.setAttribute(attribute, "guide");
      expect(linkHovercardUrl(anchor)).toBeNull();
    },
  );
  it("keeps ordinary GitHub repositories and explicit rich tooltip owners out of page previews", () => {
    const { anchor, pane } = fixture();
    anchor.href = "https://github.com/openclaw/openclaw";
    expect(linkHovercardUrl(anchor)).toBeNull();
    anchor.href = url;
    expect(linkHovercardUrl(anchor)?.hostname).toBe("example.com");
    const tooltip = pane.appendChild(document.createElement("openclaw-tooltip"));
    tooltip.append(anchor);
    expect(linkHovercardUrl(anchor)).toBeNull();
  });
});
