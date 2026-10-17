/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { ControlUiLinkReaderPreview } from "../../../src/shared/control-ui-link-reader.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import { LinkReaderHovercardProvider } from "./link-reader-hovercard.ts";
import {
  cardPart,
  createLinkFixture,
  expectIncludes,
  hover,
  hovercard,
  hovercardTestClock,
  leave,
} from "./link-reader.test-support.ts";

const TAG = `test-github-seeded-hovercard-${crypto.randomUUID()}`;
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

function createSeededLink(tag = TAG, href = PR_HREF + "#discussion_r1", scoped = true) {
  const pending = createDeferred<unknown>();
  const client = {
    request: vi.fn().mockReturnValue(pending.promise),
    connectionGeneration: 1,
    recoveryScope: "principal-a",
  };
  const properties = {
    client: (scoped ? client : { request: client.request }) as unknown as GatewayBrowserClient,
    agentId: "row-agent",
    previewSeeds: [seed],
  };
  const link = createLinkFixture(tag, href, properties, scoped ? "#99815" : "");
  return { pending, client, ...link };
}

describe("GitHub hovercards with authorized session details", () => {
  hovercardTestClock();

  it.each(["hover", "focus"])("shows known details before enrichment for %s", async (trigger) => {
    const { pending, client, provider, anchor } = createSeededLink();
    await provider.updateComplete;
    if (trigger === "hover") {
      await hover(anchor);
    } else {
      anchor.focus();
      await vi.advanceTimersByTimeAsync(0);
    }
    const card = hovercard();
    expectIncludes(card, seed.title, "Merged", "+42", "−7", "Cached details");
    expect(card?.querySelector("time")).toBeNull();
    expect(cardPart("author", card)).toBeNull();
    expect(card?.getAttribute("aria-label")).not.toContain("by ");
    expect(cardPart<HTMLAnchorElement>("title", card)?.href).toBe(anchor.href);
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
    expect(cardPart("author", card)?.getAttribute("href")).toBeNull();
    expect(card?.querySelectorAll("img")).toHaveLength(1);
    const face = card?.querySelector("img");
    expect(face?.crossOrigin).toBe("anonymous");
    face?.dispatchEvent(new Event("error"));
    expect(face && (!face.isConnected || face.hidden)).toBe(true);
    expect(cardPart("coauthors-more", card)?.textContent).toBe("+2");
    const imageUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=";
    pending.resolve({
      ...details,
      authorUrl: "https://github.com/octocat",
      coAuthors: [{ name: "Ada", imageUrl }],
      coAuthorCount: 3,
    });
    await vi.advanceTimersByTimeAsync(0);
    const loaded = cardPart("coauthors img", card);
    expect(loaded?.getAttribute("src")).toBe(imageUrl);
    loaded?.dispatchEvent(new Event("load"));
    expect(loaded?.hasAttribute("hidden")).toBe(false);
    expect(cardPart("author", card)?.getAttribute("href")).toBe("https://github.com/octocat");
  });

  it("replays session seeds assigned before the lazy provider upgrades", async () => {
    const tag = "test-github-seeded-lazy-upgrade";
    const { provider, anchor, pending, client } = createSeededLink(tag, PR_HREF, false);
    const { request } = client;
    anchor.focus();
    expect(document.activeElement).toBe(anchor);
    customElements.define(tag, class extends LinkReaderHovercardProvider {});
    await provider.updateComplete;
    expect(document.activeElement).toBe(anchor);
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(1);
    expect(hovercard()?.textContent).toContain(seed.title);
    pending.reject(new Error("Unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(hovercard()?.textContent).toContain(seed.title);
    provider.readers = [];
    expect(hovercard()).toBeNull();
    await hover(anchor);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retains the cached card through failure and reentry without bypassing request backoff", async () => {
    const { pending, client, anchor } = createSeededLink();
    const message = "GitHub API rate limit reached. Retry after 40 minutes.";
    await hover(anchor);
    pending.reject(new GatewayRequestError({ code: "UNAVAILABLE", message }));
    await vi.advanceTimersByTimeAsync(0);
    expectIncludes(hovercard(), seed.title, "Cached details", message);
    leave(anchor, document.body, false);
    await vi.advanceTimersByTimeAsync(120);
    expect(hovercard()).toBeNull();
    await hover(anchor);
    expectIncludes(hovercard(), seed.title, message);
    expect(client.request).toHaveBeenCalledTimes(1);

    leave(anchor, document.body, false);
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
      provider.remove();
      await Promise.resolve();
      document.body.append(provider);
      await provider.updateComplete;
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
    leave(anchor, document.body, false);
    await vi.advanceTimersByTimeAsync(120);
    anchor.href = "https://github.com/openclaw/openclaw/pull/99816";
    await hover(anchor);
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(hovercard()).toBeNull();
  });
});
