import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import "../test-helpers/load-styles.ts";
import { icons } from "./icons.ts";
import { renderSessionGlyph, renderSessionUnreadBadge } from "./session-glyph.ts";
import "./session-owner-chip.ts";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

afterEach(() => {
  document.body.replaceChildren();
});

describe.skipIf(!hasBrowserLayout)("sidebar glyph geometry", () => {
  it.each(["page", "owner", "group"] as const)(
    "keeps %s artwork and row geometry stable when activity starts or queues",
    async (kind) => {
      const host = document.createElement("div");
      document.body.append(host);
      const content =
        kind === "page"
          ? html`<span class="session-glyph__icon">${icons.clock}</span>`
          : html`<openclaw-session-owner-chip
              .owner=${{ type: "human", id: "ada", label: "Ada" }}
              .participants=${kind === "group" ? [{ identity: { type: "profile", id: "bob" }, label: "Bob" }] : []}
              .participantCount=${kind === "group" ? 1 : 0}
            ></openclaw-session-owner-chip>`;
      async function show(running: boolean, queued = false) {
        render(
          html`<a style="display:flex;align-items:center;gap:8px;width:220px;min-height:30px">
            ${renderSessionGlyph({ content, running, queued, circular: kind !== "page", badge: kind === "page" ? renderSessionUnreadBadge() : nothing })}
            <span data-title>Session title</span>
          </a>`,
          host,
        );
        const chip = host.querySelector("openclaw-session-owner-chip");
        if (chip) {
          await chip.updateComplete;
          await Promise.all(
            [...chip.querySelectorAll("openclaw-viewer-avatar")].map(
              (avatar) => avatar.updateComplete,
            ),
          );
        }
      }
      const artworkSelector =
        kind === "page"
          ? ".session-glyph__icon svg"
          : kind === "group"
            ? ".session-owner-stack"
            : ".session-owner-chip";
      function bounds(selector: string) {
        const element = host.querySelector(selector);
        if (!element) {
          throw new Error(`Missing ${selector}`);
        }
        return element.getBoundingClientRect();
      }
      await show(false);
      const idleArtwork = bounds(artworkSelector);
      const idleTitle = bounds("[data-title]");
      const idleRow = bounds("a");
      expect(idleArtwork.width).toBe(kind === "page" ? 16 : 20);
      expect(idleArtwork.height).toBe(kind === "page" ? 16 : 20);
      for (const queued of [false, true]) {
        await show(true, queued);
        const artwork = bounds(artworkSelector);
        expect([artwork.width, artwork.height]).toEqual([idleArtwork.width, idleArtwork.height]);
        expect(bounds("[data-title]").x).toBe(idleTitle.x);
        expect(bounds("a").height).toBe(idleRow.height);
        const ringElement = host.querySelector<HTMLElement>(".session-glyph__ring");
        if (!ringElement) {
          throw new Error("Missing activity ring");
        }
        // Exercise a nonzero rotation: the visible circle does not grow with its square box.
        for (const animation of ringElement.getAnimations()) {
          animation.pause();
          animation.currentTime = 200;
        }
        const ring = bounds(".session-glyph__ring");
        const slot = bounds(".session-glyph");
        const ringStyle = getComputedStyle(ringElement);
        expect([Number.parseFloat(ringStyle.width), Number.parseFloat(ringStyle.height)]).toEqual([
          25, 25,
        ]);
        expect(ring.x + ring.width / 2).toBeCloseTo(slot.x + slot.width / 2, 3);
        expect(ring.y + ring.height / 2).toBeCloseTo(slot.y + slot.height / 2, 3);
        if (kind === "page") {
          expect(bounds(".session-glyph__badge").width).toBe(7);
        }
      }
    },
  );

  it("preserves the compact indicator for rows with no artwork", () => {
    const host = document.createElement("div");
    document.body.append(host);
    render(renderSessionGlyph({ content: nothing, running: true }), host);
    const ring = host.querySelector(".session-glyph__ring");
    if (!ring) {
      throw new Error("Missing bare activity ring");
    }
    expect(Number.parseFloat(getComputedStyle(ring).width)).toBe(12);
  });
});
