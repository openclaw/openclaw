/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GitHubPreview } from "./github-link-hovercard-view.ts";
import { GitHubLinkHovercardProvider } from "./github-link-hovercard.runtime.ts";

const TAG = "test-github-seeded-hovercard";
customElements.define(TAG, class extends GitHubLinkHovercardProvider {});
const PR_HREF = "https://github.com/openclaw/openclaw/pull/99815";
const seed: GitHubPreview = {
  href: PR_HREF,
  kind: "pull",
  owner: "openclaw",
  repo: "openclaw",
  number: 99815,
  title: "Make Activity easier to scan",
  state: "merged",
  additions: 42,
  deletions: 7,
};
const details = {
  ...seed,
  title: "Make Activity easier to browse",
  login: "octocat",
  createdAt: "2026-07-05T08:00:00Z",
  updatedAt: "2026-07-05T09:55:00Z",
};

function createSeededLink() {
  const pending = createDeferred<unknown>();
  const client = {
    request: vi.fn().mockReturnValue(pending.promise),
    connectionGeneration: 1,
    recoveryScope: "principal-a",
  };
  const provider = document.createElement(TAG) as GitHubLinkHovercardProvider;
  provider.client = client as unknown as GatewayBrowserClient;
  provider.agentId = "row-agent";
  provider.previewSeeds = [seed];
  const anchor = document.createElement("a");
  anchor.href = PR_HREF + "#discussion_r1";
  anchor.textContent = "#99815";
  provider.append(anchor);
  document.body.append(provider);
  return { pending, client, provider, anchor };
}

function hovercard() {
  return document.querySelector<HTMLElement>(".github-link-hovercard");
}

async function hover(anchor: HTMLAnchorElement) {
  anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
  await vi.advanceTimersByTimeAsync(250);
}

function leave(anchor: HTMLAnchorElement) {
  anchor.dispatchEvent(
    new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
  );
}

describe("GitHub hovercards with authorized session details", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T10:00:00Z"));
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["hover", "focus"])("shows known details before enrichment for %s", async (trigger) => {
    const { pending, client, provider, anchor } = createSeededLink();
    if (trigger === "hover") {
      await hover(anchor);
    } else {
      anchor.focus();
      await vi.advanceTimersByTimeAsync(0);
    }
    const card = hovercard();
    expect(card?.textContent).toContain(seed.title);
    expect(card?.textContent).toContain("Merged");
    expect(card?.textContent).toContain("+42");
    expect(card?.textContent).toContain("−7");
    expect(card?.textContent).toContain("Cached details");
    expect(card?.querySelector("time")).toBeNull();
    expect(card?.querySelector(".github-link-hovercard__author")).toBeNull();
    expect(card?.getAttribute("aria-label")).not.toContain("by ");
    expect(card?.querySelector<HTMLAnchorElement>(".github-link-hovercard__title")?.href).toBe(
      anchor.href,
    );
    expect(client.request.mock.calls[0]?.[1]).toMatchObject({
      agentId: "row-agent",
      number: seed.number,
    });

    pending.resolve(details);
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()).toBe(card);
    expect(card?.textContent).toContain(details.title);
    expect(card?.textContent).toContain("octocat");
    expect(card?.textContent).not.toContain("Cached details");
    expect(card?.querySelector("time")).not.toBeNull();
    provider.remove();
  });

  it("replays session seeds assigned before the lazy provider upgrades", async () => {
    const tag = "test-github-seeded-lazy-upgrade";
    const provider = document.createElement(tag) as GitHubLinkHovercardProvider;
    const pending = createDeferred<unknown>();
    provider.client = {
      request: vi.fn().mockReturnValue(pending.promise),
    } as unknown as GatewayBrowserClient;
    provider.agentId = "row-agent";
    provider.previewSeeds = [seed];
    const anchor = document.createElement("a");
    anchor.href = PR_HREF;
    provider.append(anchor);
    document.body.append(provider);
    customElements.define(tag, class extends GitHubLinkHovercardProvider {});
    await provider.updateComplete;
    await hover(anchor);
    expect(hovercard()?.textContent).toContain(seed.title);
    pending.reject(new Error("Unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()?.textContent).toContain(seed.title);
  });

  it("retains the cached card through failure and reentry without bypassing request backoff", async () => {
    const { pending, client, anchor } = createSeededLink();
    await hover(anchor);
    pending.reject(new Error("Rate limited"));
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()?.textContent).toContain(seed.title);
    expect(hovercard()?.textContent).toContain("Cached details");
    leave(anchor);
    await vi.advanceTimersByTimeAsync(120);
    expect(hovercard()).toBeNull();
    await hover(anchor);
    expect(hovercard()?.textContent).toContain(seed.title);
    expect(client.request).toHaveBeenCalledTimes(1);

    leave(anchor);
    await vi.advanceTimersByTimeAsync(30_000);
    client.request.mockResolvedValue(details);
    await hover(anchor);
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(hovercard()?.textContent).toContain(details.title);
  });

  it.each(["agent", "client", "connection", "principal"])(
    "does not expose cached session details or late enrichment after a %s change",
    async (change) => {
      const { pending, client, provider, anchor } = createSeededLink();
      await hover(anchor);
      expect(hovercard()?.textContent).toContain(seed.title);
      if (change === "agent") {
        provider.agentId = "other-agent";
      } else if (change === "client") {
        provider.client = { ...client } as unknown as GatewayBrowserClient;
      } else if (change === "connection") {
        client.connectionGeneration += 1;
      } else {
        client.recoveryScope = "principal-b";
      }
      const current = createDeferred<unknown>();
      client.request.mockReturnValue(current.promise);
      await hover(anchor);
      pending.resolve(details);
      await vi.advanceTimersByTimeAsync(0);
      expect(hovercard()).toBeNull();
      current.reject(new Error("Unavailable"));
      await vi.advanceTimersByTimeAsync(0);
      expect(hovercard()).toBeNull();
    },
  );

  it("does not invent unavailable metrics or reuse a seed for another PR", async () => {
    const { client, provider, anchor } = createSeededLink();
    provider.previewSeeds = [{ ...seed, additions: undefined, deletions: undefined }];
    await hover(anchor);
    expect(hovercard()?.querySelectorAll(".github-link-hovercard__metric")).toHaveLength(0);
    leave(anchor);
    await vi.advanceTimersByTimeAsync(120);
    anchor.href = "https://github.com/openclaw/openclaw/pull/99816";
    await hover(anchor);
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(hovercard()).toBeNull();
  });
});
