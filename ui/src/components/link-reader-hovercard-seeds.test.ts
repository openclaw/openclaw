/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiLinkReaderPreview } from "../../../src/shared/control-ui-link-reader.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import { LinkReaderHovercardProvider } from "./link-reader-hovercard.ts";

const TAG = "test-github-seeded-hovercard";
customElements.define(TAG, class extends LinkReaderHovercardProvider {});
const PR_HREF = "https://github.com/openclaw/openclaw/pull/99815";
const seed: ControlUiLinkReaderPreview = {
  url: PR_HREF,
  subtitle: "openclaw/openclaw #99815",
  title: "Make Activity easier to scan",
  badge: { label: "Merged", tone: "accent" },
  metadata: [
    { label: "", value: "+42" },
    { label: "", value: "−7" },
  ],
};
const details = {
  ...seed,
  title: "Make Activity easier to browse",
  author: "octocat",
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
  const provider = document.createElement(TAG) as LinkReaderHovercardProvider;
  provider.client = client as unknown as GatewayBrowserClient;
  provider.agentId = "row-agent";
  provider.readers = [TEST_LINK_READER];
  provider.previewSeeds = [seed];
  const anchor = document.createElement("a");
  anchor.href = PR_HREF + "#discussion_r1";
  anchor.textContent = "#99815";
  provider.append(anchor);
  document.body.append(provider);
  return { pending, client, provider, anchor };
}

function hovercard() {
  return document.querySelector<HTMLElement>(".link-reader-hovercard");
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
    expect(card?.querySelector(".link-reader-hovercard__author")).toBeNull();
    expect(card?.getAttribute("aria-label")).not.toContain("by ");
    expect(card?.querySelector<HTMLAnchorElement>(".link-reader-hovercard__title")?.href).toBe(
      anchor.href,
    );
    expect(client.request.mock.calls[0]?.[1]).toMatchObject({
      agentId: "row-agent",
      url: anchor.href,
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

  it("keeps seeded profiles and co-author images passive through enrichment", async () => {
    const { provider, anchor, pending } = createSeededLink();
    provider.previewSeeds = [
      {
        ...seed,
        author: "Cached author",
        authorUrl: "javascript:alert(1)",
        imageUrl: "https://localhost/private.png",
        coAuthors: [
          { name: "Ada", imageUrl: "https://images.example/ada.png" },
          { name: "Mira", imageUrl: "https://127.0.0.1/private.png" },
        ],
        coAuthorCount: 3,
      },
    ];
    await hover(anchor);
    const card = hovercard();
    expect(card?.querySelector(".link-reader-hovercard__author")?.getAttribute("href")).toBeNull();
    expect(card?.querySelectorAll("img")).toHaveLength(1);
    const face = card?.querySelector("img");
    expect(face?.crossOrigin).toBe("anonymous");
    face?.dispatchEvent(new Event("error"));
    expect(face && (!face.isConnected || face.hidden)).toBe(true);
    expect(card?.querySelector(".link-reader-hovercard__coauthors-more")?.textContent).toBe("+2");
    const imageUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=";
    pending.resolve({
      ...details,
      authorUrl: "https://github.com/octocat",
      coAuthors: [{ name: "Ada", imageUrl }],
      coAuthorCount: 3,
    });
    await vi.advanceTimersByTimeAsync(0);
    const loaded = card?.querySelector(".link-reader-hovercard__coauthors img");
    expect(loaded?.getAttribute("src")).toBe(imageUrl);
    loaded?.dispatchEvent(new Event("load"));
    expect(loaded?.hasAttribute("hidden")).toBe(false);
    expect(card?.querySelector(".link-reader-hovercard__author")?.getAttribute("href")).toBe(
      "https://github.com/octocat",
    );
  });

  it("replays session seeds assigned before the lazy provider upgrades", async () => {
    const tag = "test-github-seeded-lazy-upgrade";
    const provider = document.createElement(tag) as LinkReaderHovercardProvider;
    const pending = createDeferred<unknown>();
    provider.client = {
      request: vi.fn().mockReturnValue(pending.promise),
    } as unknown as GatewayBrowserClient;
    provider.agentId = "row-agent";
    provider.readers = [TEST_LINK_READER];
    provider.previewSeeds = [seed];
    const anchor = document.createElement("a");
    anchor.href = PR_HREF;
    provider.append(anchor);
    document.body.append(provider);
    customElements.define(tag, class extends LinkReaderHovercardProvider {});
    await provider.updateComplete;
    await hover(anchor);
    expect(hovercard()?.textContent).toContain(seed.title);
    pending.reject(new Error("Unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()?.textContent).toContain(seed.title);
  });

  it("retains the cached card through failure and reentry without bypassing request backoff", async () => {
    const { pending, client, anchor } = createSeededLink();
    const message = "GitHub API rate limit reached. Retry after 40 minutes.";
    await hover(anchor);
    pending.reject(new GatewayRequestError({ code: "UNAVAILABLE", message }));
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()?.textContent).toContain(seed.title);
    expect(hovercard()?.textContent).toContain("Cached details");
    expect(hovercard()?.textContent).toContain(message);
    leave(anchor);
    await vi.advanceTimersByTimeAsync(120);
    expect(hovercard()).toBeNull();
    await hover(anchor);
    expect(hovercard()?.textContent).toContain(seed.title);
    expect(hovercard()?.textContent).toContain(message);
    expect(client.request).toHaveBeenCalledTimes(1);

    leave(anchor);
    await vi.advanceTimersByTimeAsync(30_000);
    client.request.mockResolvedValue(details);
    await hover(anchor);
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(hovercard()?.textContent).toContain(details.title);
    expect(hovercard()?.textContent).not.toContain(message);
  });

  it.each(["agent", "client", "connection", "principal", "reader"])(
    "does not expose cached session details or late enrichment after a %s change",
    async (change) => {
      const { pending, client, provider, anchor } = createSeededLink();
      await hover(anchor);
      expect(hovercard()?.textContent).toContain(seed.title);
      if (change === "agent") {
        provider.agentId = "other-agent";
      } else if (change === "client") {
        provider.client = { ...client } as unknown as GatewayBrowserClient;
      } else if (change === "reader") {
        provider.readers = [{ ...TEST_LINK_READER }];
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
      expect(hovercard()?.textContent).toContain("Could not load preview");
      expect(hovercard()?.textContent).not.toContain(seed.title);
      expect(hovercard()?.textContent).not.toContain(details.title);
    },
  );

  it("does not invent unavailable metrics or reuse a seed for another PR", async () => {
    const { client, provider, anchor } = createSeededLink();
    provider.previewSeeds = [{ ...seed, metadata: undefined }];
    await hover(anchor);
    expect(hovercard()?.querySelectorAll(".link-reader-hovercard__metric")).toHaveLength(0);
    leave(anchor);
    await vi.advanceTimersByTimeAsync(120);
    anchor.href = "https://github.com/openclaw/openclaw/pull/99816";
    await hover(anchor);
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(hovercard()).toBeNull();
  });
});
