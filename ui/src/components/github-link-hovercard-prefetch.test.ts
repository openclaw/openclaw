/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { GitHubLinkHovercardProvider } from "./github-link-hovercard.runtime.ts";
import { parseGitHubLinkTarget } from "./github-link-target.ts";

const TAG = `test-github-prefetch-${crypto.randomUUID()}`;
customElements.define(TAG, class extends GitHubLinkHovercardProvider {});
const ISSUE_HREF = "https://github.com/openclaw/openclaw/issues/99815";
const GITHUB_HOVERCARD_CLOSE_DELAY_MS = 120;

function issuePreviewResponse(overrides: Record<string, unknown> = {}) {
  return {
    comments: 2,
    createdAt: "2026-07-05T08:00:00Z",
    kind: "issue",
    login: "octocat",
    number: 99815,
    owner: "openclaw",
    repo: "openclaw",
    state: "open",
    title: "Keep hover previews reachable",
    updatedAt: "2026-07-05T09:55:00Z",
    ...overrides,
  };
}

function createIssueLink() {
  const provider = document.createElement(TAG) as GitHubLinkHovercardProvider;
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
  anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
  await vi.advanceTimersByTimeAsync(250);
}

function leave(anchor: HTMLAnchorElement) {
  anchor.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, composed: true }));
}

const hovercard = () => document.querySelector<HTMLElement>(".github-link-hovercard");

describe("GitHub hovercard prefetch subscriptions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("shares a pending prefetch with hover without aborting it on dismissal", async () => {
    const deferred = createDeferred<ReturnType<typeof issuePreviewResponse>>();
    const { anchor, provider, request } = createIssueLink();
    request.mockReturnValue(deferred.promise);
    const scope = new AbortController();
    const pending = provider.prefetch(parseGitHubLinkTarget(ISSUE_HREF)!, scope.signal);
    expect(hovercard()).toBeNull();
    await hover(anchor);
    leave(anchor);
    await vi.advanceTimersByTimeAsync(GITHUB_HOVERCARD_CLOSE_DELAY_MS);
    const requestSignal = request.mock.calls[0]![2].signal as AbortSignal;
    expect(requestSignal.aborted).toBe(false);
    await hover(anchor);
    deferred.resolve(issuePreviewResponse());
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()?.textContent).toContain("Keep hover previews reachable");
    expect(request).toHaveBeenCalledTimes(1);

    scope.abort();
    leave(anchor);
    await vi.advanceTimersByTimeAsync(GITHUB_HOVERCARD_CLOSE_DELAY_MS);
    await hover(anchor);
    expect(hovercard()?.textContent).toContain("Keep hover previews reachable");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["prefetch", "focus"])(
    "keeps warming alive when the first %s consumer leaves",
    async (firstConsumer) => {
      const deferred = createDeferred<ReturnType<typeof issuePreviewResponse>>();
      const { anchor, provider, request } = createIssueLink();
      request.mockReturnValue(deferred.promise);
      const firstScope = new AbortController();
      const target = parseGitHubLinkTarget(ISSUE_HREF)!;
      let first: Promise<unknown> | undefined;
      if (firstConsumer === "prefetch") {
        first = provider.prefetch(target, firstScope.signal).catch((error: unknown) => error);
      } else {
        anchor.focus();
        await vi.advanceTimersByTimeAsync(0);
      }
      const survivor = provider.prefetch(target, new AbortController().signal);
      const transportSignal = request.mock.calls[0]![2].signal as AbortSignal;
      if (firstConsumer === "prefetch") {
        firstScope.abort();
      } else {
        anchor.blur();
        await vi.advanceTimersByTimeAsync(GITHUB_HOVERCARD_CLOSE_DELAY_MS);
      }
      expect(transportSignal.aborted).toBe(false);
      deferred.resolve(issuePreviewResponse());
      await Promise.all([first, survivor]);
      await hover(anchor);
      expect(hovercard()?.textContent).toContain("Keep hover previews reachable");
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves disconnected previews eligible to warm after reconnect", async () => {
    const { anchor, provider, request } = createIssueLink();
    const client = { request, connected: false };
    provider.client = client as unknown as GatewayBrowserClient;
    const target = parseGitHubLinkTarget(ISSUE_HREF)!;
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
      const pending = provider.prefetch(
        parseGitHubLinkTarget(ISSUE_HREF)!,
        new AbortController().signal,
      );
      const signal = request.mock.calls[0]![2].signal as AbortSignal;
      if (change === "agent") {
        provider.agentId = "other";
      } else if (change === "client") {
        provider.client = { request } as unknown as GatewayBrowserClient;
      } else {
        provider.remove();
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
