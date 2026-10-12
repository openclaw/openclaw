/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { TEST_LINK_READER, testLinkPreview } from "../test-helpers/link-reader.ts";
import { LinkReaderHovercardProvider } from "./link-reader-hovercard.ts";
import { resolveLinkReaderTarget } from "./link-reader-target.ts";

const TAG = `test-github-prefetch-${crypto.randomUUID()}`;
customElements.define(TAG, class extends LinkReaderHovercardProvider {});
const ISSUE_HREF = "https://github.com/openclaw/openclaw/issues/99815";
const GITHUB_HOVERCARD_CLOSE_DELAY_MS = 120;

function issuePreviewResponse(overrides: Record<string, unknown> = {}) {
  return { ...testLinkPreview(), ...overrides };
}

function createIssueLink() {
  const provider = document.createElement(TAG) as LinkReaderHovercardProvider;
  provider.readers = [TEST_LINK_READER];
  const anchor = document.createElement("a");
  anchor.href = ISSUE_HREF;
  anchor.textContent = "#99815";
  provider.append(anchor);
  document.body.append(provider);
  const request = vi.fn().mockResolvedValue(issuePreviewResponse());
  provider.client = { request, connected: true } as unknown as GatewayBrowserClient;
  return { provider, anchor, request };
}

async function hover(anchor: HTMLAnchorElement) {
  await Promise.resolve(); // Allow the bridge to mount before dispatching intent.
  anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
  await vi.advanceTimersByTimeAsync(250);
}

function leave(anchor: HTMLAnchorElement) {
  anchor.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, composed: true }));
}

const hovercard = () => document.querySelector<HTMLElement>(".link-reader-hovercard");

describe("GitHub hovercard prefetch subscriptions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    document.body.replaceChildren();
    await Promise.resolve();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it.each(["agent", "destination"])(
    "projects inline facts without extra requests until %s changes",
    async (change) => {
      const { provider, anchor, request } = createIssueLink();
      anchor.className = "markdown-github-item";
      if (change === "agent") {
        anchor.href = "https://github.com/openclaw/openclaw/pull/142276";
        anchor.classList.add("markdown-github-link");
      }
      const other = anchor.cloneNode(true) as HTMLAnchorElement;
      if (change === "agent") {
        other.href = "https://github.com/another/project/pull/142276";
        provider.append(other);
        request.mockResolvedValue(
          issuePreviewResponse({ url: anchor.href, badge: { label: "Merged", tone: "accent" } }),
        );
      }
      await provider.prefetch(
        resolveLinkReaderTarget(anchor.href, [TEST_LINK_READER])!,
        new AbortController().signal,
      );
      if (change === "agent") {
        expect(anchor.dataset.linkReaderTone).toBe("accent");
        expect(other.dataset.linkReaderTone).toBeUndefined();
        await hover(anchor);
        expect(request).toHaveBeenCalledTimes(1);
        provider.agentId = "other";
        expect(anchor.dataset.linkReaderTone).toBeUndefined();
      } else {
        const replacement = anchor.cloneNode(true) as HTMLAnchorElement;
        delete replacement.dataset.linkReaderTone;
        provider.replaceChildren(replacement);
        await vi.advanceTimersByTimeAsync(0);
        expect(replacement.dataset.linkReaderTone).toBe("positive");
        replacement.href = "https://github.com/other/repo/issues/99815";
        await vi.advanceTimersByTimeAsync(0);
        expect(replacement.dataset.linkReaderTone).toBeUndefined();
        expect(replacement.hasAttribute("aria-description")).toBe(false);
        expect(request).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([
    { phase: "pending", change: "connection" },
    { phase: "pending", change: "principal" },
    { phase: "cached", change: "connection" },
    { phase: "cached", change: "principal" },
  ])("retires $phase inline state after $change changes", async ({ phase, change }) => {
    const { provider, anchor, request } = createIssueLink();
    anchor.className = "markdown-github-item";
    const client = { request, connected: true, connectionGeneration: 1, recoveryScope: "first" };
    provider.client = client as unknown as GatewayBrowserClient;
    const target = resolveLinkReaderTarget(anchor.href, [TEST_LINK_READER])!;
    const pending =
      phase === "pending" ? createDeferred<ReturnType<typeof issuePreviewResponse>>() : undefined;
    if (pending) {
      request.mockReturnValueOnce(pending.promise);
    }
    await provider.updateComplete;
    const loading = provider.prefetch(target, new AbortController().signal);
    if (!pending) {
      await loading;
      expect(anchor.dataset.linkReaderTone).toBe("positive");
    }
    if (change === "connection") {
      client.connectionGeneration++;
    } else {
      client.recoveryScope = "next";
    }
    let chip = anchor;
    if (pending) {
      pending.resolve(issuePreviewResponse());
      await loading;
      expect(chip.dataset.linkReaderTone).toBeUndefined();
    } else {
      chip = anchor.cloneNode(true) as HTMLAnchorElement;
      provider.replaceChildren(chip);
      await vi.advanceTimersByTimeAsync(0);
      expect(chip.dataset.linkReaderTone).toBeUndefined();
      expect(chip.hasAttribute("aria-description")).toBe(false);
      expect(request).toHaveBeenCalledTimes(1);
    }
    await provider.prefetch(target, new AbortController().signal);
    expect(chip.dataset.linkReaderTone).toBe("positive");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["hover", "prefetch", "focus"])(
    "keeps shared warming alive when the %s consumer leaves",
    async (consumer) => {
      const deferred = createDeferred<ReturnType<typeof issuePreviewResponse>>();
      const { anchor, provider, request } = createIssueLink();
      request.mockReturnValue(deferred.promise);
      const firstScope = new AbortController();
      const target = resolveLinkReaderTarget(ISSUE_HREF, [TEST_LINK_READER])!;
      await provider.updateComplete;
      let first: Promise<unknown> | undefined;
      let survivor: Promise<void>;
      if (consumer === "hover") {
        survivor = provider.prefetch(target, firstScope.signal);
        expect(hovercard()).toBeNull();
        await hover(anchor);
      } else {
        if (consumer === "prefetch") {
          first = provider.prefetch(target, firstScope.signal).catch((error: unknown) => error);
        } else {
          anchor.focus();
          await vi.advanceTimersByTimeAsync(0);
        }
        survivor = provider.prefetch(target, new AbortController().signal);
      }
      const transportSignal = request.mock.calls[0]![2].signal as AbortSignal;
      if (consumer === "prefetch") {
        firstScope.abort();
      } else {
        if (consumer === "hover") {
          leave(anchor);
        } else {
          anchor.blur();
        }
        await vi.advanceTimersByTimeAsync(GITHUB_HOVERCARD_CLOSE_DELAY_MS);
      }
      expect(transportSignal.aborted).toBe(false);
      if (consumer === "hover") {
        await hover(anchor);
      }
      deferred.resolve(issuePreviewResponse());
      await Promise.all([first, survivor]);
      if (consumer === "hover") {
        await vi.advanceTimersByTimeAsync(0);
      } else {
        await hover(anchor);
      }
      expect(hovercard()?.textContent).toContain("Keep hover previews reachable");
      expect(request).toHaveBeenCalledTimes(1);
      if (consumer === "hover") {
        firstScope.abort();
        leave(anchor);
        await vi.advanceTimersByTimeAsync(GITHUB_HOVERCARD_CLOSE_DELAY_MS);
        await hover(anchor);
        expect(hovercard()?.textContent).toContain("Keep hover previews reachable");
        expect(request).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("leaves disconnected previews eligible to warm after reconnect", async () => {
    const { anchor, provider, request } = createIssueLink();
    const client = { request, connected: false };
    provider.client = client as unknown as GatewayBrowserClient;
    const target = resolveLinkReaderTarget(ISSUE_HREF, [TEST_LINK_READER])!;
    await provider.prefetch(target, new AbortController().signal);
    expect(request).not.toHaveBeenCalled();

    client.connected = true;
    await provider.prefetch(target, new AbortController().signal);
    await hover(anchor);
    expect(hovercard()?.textContent).toContain("Keep hover previews reachable");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["agent", "client", "disconnect"])(
    "retires pending prefetch on %s changes",
    async (change) => {
      const old = createDeferred<ReturnType<typeof issuePreviewResponse>>();
      const { anchor, provider, request } = createIssueLink();
      request.mockReturnValueOnce(old.promise);
      await provider.updateComplete;
      const pending = provider.prefetch(
        resolveLinkReaderTarget(ISSUE_HREF, [TEST_LINK_READER])!,
        new AbortController().signal,
      );
      const signal = request.mock.calls[0]![2].signal as AbortSignal;
      if (change === "agent") {
        provider.agentId = "other";
      } else if (change === "client") {
        provider.client = { request } as unknown as GatewayBrowserClient;
      } else {
        provider.remove();
        await Promise.resolve();
        document.body.append(provider);
      }
      expect(signal.aborted).toBe(true);
      await hover(anchor);
      old.resolve(issuePreviewResponse({ title: "Retired identity" }));
      await pending;
      await vi.advanceTimersByTimeAsync(0);
      expect(hovercard()?.textContent).toContain("Keep hover previews reachable");
      expect(hovercard()?.textContent).not.toContain("Retired identity");
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
});
