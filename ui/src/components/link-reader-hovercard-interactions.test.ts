/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { TEST_LINK_READER, testLinkPreview } from "../test-helpers/link-reader.ts";
import { LazyHovercardBootstrap } from "./lazy-hovercard-registration.ts";
import { LinkReaderHovercardProvider } from "./link-reader-hovercard.ts";
const ELEMENT_NAME = "test-link-reader-interaction-" + crypto.randomUUID();
customElements.define(ELEMENT_NAME, class extends LinkReaderHovercardProvider {});
const ISSUE_HREF = "https://github.com/openclaw/openclaw/issues/99815";
function createLink(href: string) {
  const provider = document.createElement(ELEMENT_NAME) as LinkReaderHovercardProvider;
  provider.readers = [TEST_LINK_READER];
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = "Item";
  provider.append(anchor);
  document.body.append(provider);
  return { provider, anchor };
}
function issuePreviewResponse(overrides: Record<string, unknown> = {}) {
  return {
    ...testLinkPreview(),
    ...(typeof overrides.number === "number"
      ? { url: "https://github.com/openclaw/openclaw/issues/" + overrides.number }
      : {}),
    ...overrides,
  };
}
function createIssueLink() {
  const link = createLink(ISSUE_HREF);
  const request = vi.fn().mockResolvedValue(issuePreviewResponse());
  link.provider.client = { request } as unknown as GatewayBrowserClient;
  return { ...link, request };
}
const hovercard = () => document.querySelector<HTMLElement>(".link-reader-hovercard");
const titleLinkInCard = () =>
  document.querySelector<HTMLAnchorElement>("a.link-reader-hovercard__title");
const cardLinks = () => [
  ...document.querySelectorAll<HTMLAnchorElement>(".link-reader-hovercard a[href]"),
];
async function hover(anchor: HTMLAnchorElement) {
  anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
  await vi.advanceTimersByTimeAsync(250);
}
function leave(anchor: HTMLAnchorElement, relatedTarget: EventTarget = document.body) {
  anchor.dispatchEvent(
    new MouseEvent("pointerout", { bubbles: true, composed: true, relatedTarget }),
  );
}
function observeHovercardMounts() {
  const titles: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches(".link-reader-hovercard")) {
          titles.push(node.querySelector(".link-reader-hovercard__title")?.textContent ?? "");
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  onTestFinished(() => observer.disconnect());
  return titles;
}
describe("generic preview portal lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T10:00:00Z"));
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it.each(["immediate rejection", "late rejection"])(
    "reopens an abandoned request without poisoning its replacement cache: %s",
    async (settlement) => {
      const abandoned = createDeferred<ReturnType<typeof issuePreviewResponse>>();
      let requestSignal: AbortSignal | undefined;
      const request = vi
        .fn()
        .mockImplementationOnce(
          (_method: string, _params: unknown, options: { signal: AbortSignal }) => {
            requestSignal = options.signal;
            if (settlement === "immediate rejection") {
              options.signal.addEventListener(
                "abort",
                () => abandoned.reject(new Error("gateway request aborted")),
                { once: true },
              );
            }
            return abandoned.promise;
          },
        )
        .mockResolvedValue(issuePreviewResponse());
      const { anchor, provider } = createLink(ISSUE_HREF);
      provider.client = { request } as unknown as GatewayBrowserClient;

      await hover(anchor);
      expect(hovercard()).toBeNull();
      leave(anchor);
      await vi.advanceTimersByTimeAsync(120);
      expect(requestSignal?.aborted).toBe(true);
      await hover(anchor);
      expect(request).toHaveBeenCalledTimes(2);
      expect(hovercard()?.textContent).toContain("Keep hover previews reachable");

      abandoned.reject(new Error("gateway request aborted"));
      await vi.advanceTimersByTimeAsync(0);
      expect(hovercard()?.textContent).toContain("Keep hover previews reachable");
      leave(anchor);
      await vi.advanceTimersByTimeAsync(120);
      await hover(anchor);
      expect(request).toHaveBeenCalledTimes(2);
      expect(hovercard()?.textContent).toContain("Keep hover previews reachable");
    },
  );

  it("shows a pending preview rejection without moving focus and keeps its original link reachable", async () => {
    const pending = createDeferred<unknown>();
    const { anchor, provider } = createLink(ISSUE_HREF);
    provider.client = {
      request: vi.fn().mockReturnValue(pending.promise),
    } as unknown as GatewayBrowserClient;
    anchor.focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()).toBeNull();
    pending.reject(new Error("Gateway request timed out"));
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()?.textContent).toContain("Try again or open the original.");
    expect(document.activeElement).toBe(anchor);
    expect(anchor.getAttribute("aria-controls")).toBe(hovercard()?.id);
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
    const tab = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" });
    anchor.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(hovercard()?.querySelector("a"));
    expect((document.activeElement as HTMLAnchorElement).href).toBe(ISSUE_HREF);
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
    );
    expect(hovercard()).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });

  it.each(["pointer", "focus"])(
    "mounts only a populated successful preview for %s intent",
    async (trigger) => {
      const mountedCards = observeHovercardMounts();
      const pending = createDeferred<ReturnType<typeof issuePreviewResponse>>();
      const { anchor, provider } = createLink(ISSUE_HREF);
      const request = vi.fn().mockReturnValue(pending.promise);
      provider.client = { request } as unknown as GatewayBrowserClient;
      if (trigger === "pointer") {
        anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
        await vi.advanceTimersByTimeAsync(249);
        expect(request).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      } else {
        anchor.focus();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mountedCards).toEqual([]);
      expect(anchor.hasAttribute("aria-haspopup")).toBe(false);
      expect(anchor.hasAttribute("aria-controls")).toBe(false);
      pending.resolve(issuePreviewResponse());
      await vi.advanceTimersByTimeAsync(0);
      expect(mountedCards).toEqual(["Keep hover previews reachable"]);
      expect(anchor.getAttribute("aria-expanded")).toBe("true");
      expect(titleLinkInCard()?.href).toBe(ISSUE_HREF);
    },
  );

  it.each([
    { dismissal: "pointer leave", settlement: "success" },
    { dismissal: "pointer leave", settlement: "failure" },
    { dismissal: "focus leave", settlement: "success" },
    { dismissal: "Escape", settlement: "success" },
    { dismissal: "click", settlement: "success" },
    { dismissal: "route replacement", settlement: "success" },
    { dismissal: "href change", settlement: "success" },
    { dismissal: "agent change", settlement: "success" },
    { dismissal: "client change", settlement: "success" },
    { dismissal: "disconnect", settlement: "success" },
  ])("does not mount a late $settlement after $dismissal", async ({ dismissal, settlement }) => {
    const mountedCards = observeHovercardMounts();
    const pending = createDeferred<ReturnType<typeof issuePreviewResponse>>();
    const { anchor, provider } = createLink(ISSUE_HREF);
    let signal: AbortSignal | undefined;
    provider.client = {
      request: vi.fn((_method, _params, options: { signal: AbortSignal }) => {
        signal = options.signal;
        return pending.promise;
      }),
    } as unknown as GatewayBrowserClient;
    if (dismissal === "focus leave") {
      anchor.focus();
      await vi.advanceTimersByTimeAsync(0);
    } else {
      await hover(anchor);
    }
    expect(signal).toBeDefined();
    if (dismissal === "pointer leave") {
      leave(anchor);
    } else if (dismissal === "focus leave") {
      anchor.blur();
    } else if (dismissal === "Escape") {
      anchor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    } else if (dismissal === "click") {
      anchor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    } else if (dismissal === "route replacement") {
      provider.replaceChildren();
    } else if (dismissal === "href change") {
      anchor.href = "https://example.com/changed";
    } else if (dismissal === "agent change") {
      provider.agentId = "other-agent";
    } else if (dismissal === "client change") {
      provider.client = null;
    } else {
      provider.remove();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(true);
    if (settlement === "success") {
      pending.resolve(issuePreviewResponse());
    } else {
      pending.reject(new Error("GitHub API rate limit reached"));
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mountedCards).toEqual([]);
    expect(hovercard()).toBeNull();
  });

  it.each(["old first", "new first"])(
    "keeps delayed permalink ownership when responses settle %s",
    async (order) => {
      const mountedCards = observeHovercardMounts();
      const abandoned = createDeferred<ReturnType<typeof issuePreviewResponse>>();
      const current = createDeferred<ReturnType<typeof issuePreviewResponse>>();
      const { anchor, provider } = createLink(ISSUE_HREF);
      const replacement = document.createElement("a");
      replacement.href = ISSUE_HREF + "#issuecomment-456";
      provider.append(replacement);
      const request = vi
        .fn()
        .mockReturnValueOnce(abandoned.promise)
        .mockReturnValueOnce(current.promise);
      provider.client = { request } as unknown as GatewayBrowserClient;
      await hover(anchor);
      await hover(replacement);
      expect(request).toHaveBeenCalledTimes(2);
      if (order === "old first") {
        abandoned.resolve(issuePreviewResponse({ title: "Stale result" }));
        await vi.advanceTimersByTimeAsync(0);
        expect(mountedCards).toEqual([]);
      }
      current.resolve(issuePreviewResponse());
      await vi.advanceTimersByTimeAsync(0);
      if (order === "new first") {
        abandoned.resolve(issuePreviewResponse({ title: "Stale result" }));
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(mountedCards).toEqual(["Keep hover previews reachable"]);
      expect(titleLinkInCard()?.href).toBe(replacement.href);
      expect(
        hovercard()?.querySelector<HTMLAnchorElement>(".link-reader-hovercard__subtitle")?.href,
      ).toBe(replacement.href);
      expect(anchor.hasAttribute("aria-controls")).toBe(false);
    },
  );

  it.each(["pointer", "focus"])(
    "uses only the nearest provider's agent for nested %s intent",
    async (trigger) => {
      const request = vi.fn().mockResolvedValue(issuePreviewResponse());
      const client = { request } as unknown as GatewayBrowserClient;
      const outer = createLink(ISSUE_HREF);
      outer.provider.client = client;
      outer.provider.agentId = "selected-agent";
      const inner = createLink(ISSUE_HREF);
      inner.provider.client = client;
      inner.provider.agentId = "row-agent";
      outer.provider.append(inner.provider);

      if (trigger === "pointer") {
        await hover(inner.anchor);
      } else {
        inner.anchor.focus();
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[1]).toMatchObject({ agentId: "row-agent" });
      expect(document.querySelectorAll(".link-reader-hovercard")).toHaveLength(1);
      expect(titleLinkInCard()?.textContent).toBe("Keep hover previews reachable");
      inner.anchor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      expect(hovercard()).toBeNull();

      await hover(outer.anchor);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]?.[1]).toMatchObject({ agentId: "selected-agent" });
      expect(document.querySelectorAll(".link-reader-hovercard")).toHaveLength(1);
    },
  );

  it("shares successful loading state across providers and shows cached failures", async () => {
    const first = createDeferred<ReturnType<typeof issuePreviewResponse>>();
    const failure = createDeferred<ReturnType<typeof issuePreviewResponse>>();
    const retry = createDeferred<ReturnType<typeof issuePreviewResponse>>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(failure.promise)
      .mockReturnValueOnce(retry.promise);
    const client = {
      request,
      connectionGeneration: 1,
      recoveryScope: "principal-a",
    } as unknown as GatewayBrowserClient;
    const one = createLink(ISSUE_HREF);
    one.provider.client = client;
    await hover(one.anchor);
    expect(hovercard()).toBeNull();
    first.resolve(issuePreviewResponse());
    await vi.advanceTimersByTimeAsync(0);
    expect(titleLinkInCard()?.textContent).toBe("Keep hover previews reachable");
    one.provider.remove();
    const two = createLink("https://github.com/openclaw/openclaw/issues/99816");
    two.provider.client = client;
    const mounted = observeHovercardMounts();
    two.anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
    await vi.advanceTimersByTimeAsync(249);
    expect(mounted).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hovercard()?.dataset.loading).toBe("true");
    expect(hovercard()?.getAttribute("aria-label")).toBe("Loading preview…");
    failure.reject(new GatewayRequestError({ code: "UNAVAILABLE", message: "Not Found" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()?.textContent).toContain("Not Found");
    leave(two.anchor);
    await vi.advanceTimersByTimeAsync(120);
    await hover(two.anchor);
    expect(hovercard()?.textContent).toContain("Not Found");
    expect(request).toHaveBeenCalledTimes(2);
    leave(two.anchor);
    await vi.advanceTimersByTimeAsync(30_000);
    await hover(two.anchor);
    expect(request).toHaveBeenCalledTimes(3);
    expect(hovercard()?.dataset.loading).toBe("true");
    leave(two.anchor);
    retry.resolve(issuePreviewResponse({ number: 99816 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()).toBeNull();
  });

  it.each(["client", "agent", "agent round trip", "connection", "principal"])(
    "retires cached details and requests current metadata after a %s change",
    async (change) => {
      const pending = createDeferred<ReturnType<typeof issuePreviewResponse>>();
      const request = vi
        .fn()
        .mockResolvedValueOnce(issuePreviewResponse())
        .mockReturnValue(pending.promise);
      const client = { request, connectionGeneration: 1, recoveryScope: "principal-a" };
      const { anchor, provider } = createLink(ISSUE_HREF);
      provider.client = client as unknown as GatewayBrowserClient;
      await hover(anchor);
      expect(titleLinkInCard()).not.toBeNull();
      leave(anchor);
      await vi.advanceTimersByTimeAsync(120);
      if (change === "client") {
        provider.client = { ...client } as unknown as GatewayBrowserClient;
      } else if (change === "agent" || change === "agent round trip") {
        provider.agentId = "other";
        if (change === "agent round trip") {
          provider.agentId = undefined;
        }
      } else if (change === "connection") {
        client.connectionGeneration += 1;
      } else {
        client.recoveryScope = "principal-b";
      }
      const mounted = observeHovercardMounts();
      await hover(anchor);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]?.[1]).toMatchObject({
        ...(change === "agent" ? { agentId: "other" } : {}),
        url: ISSUE_HREF,
      });
      expect(titleLinkInCard()).toBeNull();
      if (change === "agent round trip") {
        expect(hovercard()?.dataset.loading).toBe("true");
      } else {
        expect(hovercard()).toBeNull();
        expect(mounted).toEqual([]);
      }
      pending.resolve(issuePreviewResponse({ title: "Current identity details" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(titleLinkInCard()?.textContent).toBe("Current identity details");
    },
  );

  it.each([
    ["agent", "agent-a"],
    ["client", "agent-b"],
  ])(
    "preserves the unchanged provider when a peer changes its %s from %s",
    async (change, peerAgentId) => {
      const pending = createDeferred<ReturnType<typeof issuePreviewResponse>>();
      const next = createDeferred<ReturnType<typeof issuePreviewResponse>>();
      const request = vi
        .fn()
        .mockResolvedValueOnce(issuePreviewResponse())
        .mockResolvedValueOnce(issuePreviewResponse({ number: 99816 }))
        .mockRejectedValueOnce(
          new GatewayRequestError({ code: "UNAVAILABLE", message: "Not Found" }),
        )
        .mockReturnValueOnce(pending.promise)
        .mockReturnValueOnce(next.promise);
      const client = {
        request,
        connectionGeneration: 1,
        recoveryScope: "principal",
      } as unknown as GatewayBrowserClient;
      const one = createLink(ISSUE_HREF);
      one.provider.client = client;
      one.provider.agentId = "agent-a";
      await hover(one.anchor);
      leave(one.anchor);
      await vi.advanceTimersByTimeAsync(120);
      const two = createLink("https://github.com/openclaw/openclaw/issues/99816");
      two.provider.client = client;
      two.provider.agentId = peerAgentId;
      await hover(two.anchor);
      leave(two.anchor);
      await vi.advanceTimersByTimeAsync(120);
      const failed = document.createElement("a");
      failed.href = "https://github.com/openclaw/openclaw/issues/99818";
      one.provider.append(failed);
      await hover(failed);
      expect(hovercard()?.textContent).toContain("Not Found");
      one.anchor.href = "https://github.com/openclaw/openclaw/issues/99817";
      await hover(one.anchor);
      expect(hovercard()?.dataset.loading).toBe("true");
      if (change === "agent") {
        two.provider.agentId = "agent-c";
      } else {
        two.provider.client = { request } as unknown as GatewayBrowserClient;
      }
      pending.resolve(issuePreviewResponse({ number: 99817, title: "Agent A remains current" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(titleLinkInCard()?.textContent).toBe("Agent A remains current");
      leave(one.anchor);
      await vi.advanceTimersByTimeAsync(120);
      await hover(failed);
      expect(hovercard()?.textContent).toContain("Not Found");
      expect(request).toHaveBeenCalledTimes(4);
      one.anchor.href = "https://github.com/openclaw/openclaw/issues/99819";
      await hover(one.anchor);
      expect(hovercard()?.dataset.loading).toBe("true");
      leave(one.anchor);
      next.resolve(issuePreviewResponse({ number: 99819 }));
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it("does not unlock a new auth generation with a stale successful response", async () => {
    const stale = createDeferred<ReturnType<typeof issuePreviewResponse>>();
    const current = createDeferred<ReturnType<typeof issuePreviewResponse>>();
    const request = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const client = { request, connectionGeneration: 1, recoveryScope: "principal-a" };
    const one = createLink(ISSUE_HREF);
    one.provider.client = client as unknown as GatewayBrowserClient;
    await hover(one.anchor);
    client.connectionGeneration += 1;
    stale.resolve(issuePreviewResponse());
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()).toBeNull();
    const two = createLink(ISSUE_HREF);
    two.provider.client = client as unknown as GatewayBrowserClient;
    await hover(two.anchor);
    expect(hovercard()).toBeNull();
    current.resolve(issuePreviewResponse());
    await vi.advanceTimersByTimeAsync(0);
    expect(titleLinkInCard()).not.toBeNull();
  });

  it("stays open while the pointer travels from the link onto the card", async () => {
    const { anchor } = createIssueLink();

    await hover(anchor);
    const card = hovercard();
    expect(card).not.toBeNull();

    // Crossing the gap between the link and the card leaves both unhovered.
    leave(anchor, card as EventTarget);
    await vi.advanceTimersByTimeAsync(120 - 1);
    expect(hovercard()).toBe(card);

    card?.dispatchEvent(new MouseEvent("pointerenter"));
    await vi.advanceTimersByTimeAsync(120 * 10);
    expect(hovercard()).toBe(card);

    card?.dispatchEvent(new MouseEvent("pointerleave"));
    expect(hovercard()).toBe(card);
    await vi.advanceTimersByTimeAsync(120);
    expect(hovercard()).toBeNull();
    expect(anchor.hasAttribute("aria-expanded")).toBe(false);
    expect(anchor.hasAttribute("aria-controls")).toBe(false);
    expect(anchor.hasAttribute("aria-haspopup")).toBe(false);
  });

  it("closes on pointer-out even after the title link inside the card was clicked", async () => {
    const { anchor } = createIssueLink();

    await hover(anchor);
    const card = hovercard();
    expect(card).not.toBeNull();

    // Pointer travels from the link onto the card, same as the traversal test above.
    leave(anchor, card as EventTarget);
    card?.dispatchEvent(new MouseEvent("pointerenter"));
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()).toBe(card);

    // Clicking the title link focuses it (a click's real-world side effect); a
    // pointer-initiated open must still release once the pointer leaves, with no
    // click-outside required to dismiss the card.
    const titleLink = titleLinkInCard();
    titleLink?.addEventListener("click", (event) => event.preventDefault());
    titleLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    titleLink?.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));

    card?.dispatchEvent(new MouseEvent("pointerleave"));
    await vi.advanceTimersByTimeAsync(120);
    expect(hovercard()).toBeNull();
  });

  it.each([false, true])("hands focus back at Tab edges (shiftKey=%s)", async (shiftKey) => {
    const { anchor } = createIssueLink();

    anchor.focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()).not.toBeNull();

    // The card is portaled to document.body, so Tab has to be forwarded for any
    // of its links to be reachable at all.
    anchor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    expect(document.activeElement).toBe(cardLinks()[0]);

    // Inside the run of card links Tab belongs to the browser, not to the card.
    const middle = cardLinks()[0];
    middle?.focus();
    const insideTab = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" });
    middle?.dispatchEvent(insideTab);
    expect(insideTab.defaultPrevented).toBe(false);
    expect(hovercard()).not.toBeNull();

    // Leaving either outer edge returns focus to the trigger with the card closed,
    // and that returned focus must not immediately reopen what was dismissed.
    const edge = shiftKey ? cardLinks()[0] : cardLinks().at(-1);
    edge?.focus();
    edge?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab", shiftKey }));
    expect(hovercard()).toBeNull();
    expect(document.activeElement).toBe(anchor);
    await vi.advanceTimersByTimeAsync(120 * 2);
    expect(hovercard()).toBeNull();
  });

  it("closes once focus leaves both the link and the card", async () => {
    const { anchor } = createIssueLink();
    const outside = document.createElement("button");
    document.body.append(outside);

    anchor.focus();
    await vi.advanceTimersByTimeAsync(0);
    anchor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    expect(document.activeElement).toBe(cardLinks()[0]);

    outside.focus();
    await vi.advanceTimersByTimeAsync(120);
    expect(hovercard()).toBeNull();
    expect(anchor.hasAttribute("aria-expanded")).toBe(false);
  });

  it("uses the latest dependencies assigned before its lazy definition finishes", async () => {
    const tag = `test-github-lazy-upgrade-${crypto.randomUUID()}`;
    const loaded = createDeferred<CustomElementConstructor>();
    const bootstrap = new LazyHovercardBootstrap<LinkReaderHovercardProvider>({
      tag,
      load: () => loaded.promise,
    });
    const provider = document.createElement(tag) as LinkReaderHovercardProvider;
    const anchor = document.createElement("a");
    anchor.href = ISSUE_HREF;
    provider.append(anchor);
    document.body.append(provider);
    const staleRequest = vi.fn();
    provider.client = { request: staleRequest } as unknown as GatewayBrowserClient;
    provider.agentId = "first-agent";
    provider.readers = [TEST_LINK_READER];

    const definition = bootstrap.define();
    const request = vi.fn().mockResolvedValue(issuePreviewResponse());
    provider.client = { request } as unknown as GatewayBrowserClient;
    provider.agentId = "second-agent";
    loaded.resolve(class extends LinkReaderHovercardProvider {});
    await definition;
    await provider.updateComplete;
    await hover(anchor);

    expect(staleRequest).not.toHaveBeenCalled();
    expect(request.mock.calls[0]?.[1]).toMatchObject({ agentId: "second-agent" });
    expect(hovercard()?.textContent).toContain("Keep hover previews reachable");
    provider.agentId = "third-agent";
    expect(hovercard()).toBeNull();
    await hover(anchor);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ agentId: "third-agent" });
  });

  it.each([
    "https://github.com:8443/openclaw/openclaw/issues/99815",
    "https://github.com.example.com/openclaw/openclaw/issues/99815",
    "blob:https://github.com/issues/99815",
  ])("does not preview an untrusted item URL: %s", async (href) => {
    const request = vi.fn();
    const { anchor, provider } = createLink(href);
    provider.client = { request } as unknown as GatewayBrowserClient;

    await hover(anchor);

    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector(".link-reader-hovercard")).toBeNull();
  });

  it.each(["pending", "held"])(
    "retires a %s GitHub preview when its pane becomes inert",
    async (phase) => {
      const { anchor, provider, request } = createIssueLink();
      const pane = document.createElement("section");
      provider.append(pane);
      pane.append(anchor);
      anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
      if (phase === "held") {
        await vi.advanceTimersByTimeAsync(250);
        expect(hovercard()).not.toBeNull();
        hovercard()!.dispatchEvent(new MouseEvent("pointerenter"));
      }
      pane.setAttribute("inert", "");
      await vi.advanceTimersByTimeAsync(250);
      expect(hovercard()).toBeNull();
      expect(anchor.hasAttribute("aria-expanded")).toBe(false);
      if (phase === "pending") {
        expect(request).not.toHaveBeenCalled();
      }
    },
  );

  it("closes when route replacement removes its active link", async () => {
    const { provider, anchor } = createIssueLink();
    const route = document.createElement("main");
    route.append(anchor);
    provider.append(route);

    await hover(anchor);
    expect(document.querySelector(".link-reader-hovercard")).not.toBeNull();

    route.replaceChildren(document.createElement("p"));
    await Promise.resolve();

    expect(document.querySelector(".link-reader-hovercard")).toBeNull();
    expect(anchor.hasAttribute("aria-expanded")).toBe(false);
  });
});
