import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import "../test-helpers/load-styles.ts";
import { Icon } from "./solid/icon.tsx";
import { SessionOwnerChip } from "./solid/session-owner-chip.tsx";
import { SessionGlyph, renderSessionUnreadBadge } from "./solid/session-presentation.tsx";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

afterEach(() => {
  document.body.replaceChildren();
});

describe.skipIf(!hasBrowserLayout)("sidebar glyph geometry", () => {
  it.each(["page", "owner"] as const)(
    "keeps %s artwork and row geometry stable when activity starts or queues",
    async (kind) => {
      const host = document.createElement("div");
      document.body.append(host);
      const query = (selector: string) => expectDefined(host.querySelector(selector), selector);
      let view: ReturnType<typeof mountSolid> | undefined;
      async function show(running: boolean, queued = false) {
        view?.unmount();
        view = mountSolid(
          () => (
            <a
              style={{
                display: "flex",
                "align-items": "center",
                gap: "8px",
                width: "220px",
                "min-height": "30px",
              }}
            >
              <SessionGlyph
                content={
                  kind === "page" ? (
                    <span class="session-glyph__icon">
                      <Icon name="clock" />
                    </span>
                  ) : (
                    <SessionOwnerChip owner={{ type: "human", id: "ada", label: "Ada" }} />
                  )
                }
                running={running}
                queued={queued}
                circular={kind !== "page"}
                badge={kind === "page" ? renderSessionUnreadBadge() : undefined}
              />
              <span data-title>Session title</span>
            </a>
          ),
          { container: host },
        );
        flush();
        const artwork = query(".session-glyph__content");
        await Promise.all(
          artwork
            .getAnimations()
            .filter((animation) => animation instanceof CSSTransition)
            .map((animation) => animation.finished),
        );
      }
      const artworkSelector = kind === "page" ? ".session-glyph__icon svg" : ".session-owner-chip";
      const bounds = (selector: string) => query(selector).getBoundingClientRect();
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
        const ringElement = query(".session-glyph__ring");
        // Exercise a nonzero rotation: the visible circle does not grow with its square box.
        for (const animation of ringElement.getAnimations()) {
          animation.pause();
          animation.currentTime = 200;
        }
        const ring = bounds(".session-glyph__ring");
        const slot = bounds(".session-glyph");
        const ringStyle = getComputedStyle(ringElement);
        expect([ringStyle.width, ringStyle.height]).toEqual(["25px", "25px"]);
        expect(ring.x + ring.width / 2).toBeCloseTo(slot.x + slot.width / 2, 3);
        expect(ring.y + ring.height / 2).toBeCloseTo(slot.y + slot.height / 2, 3);
        if (kind === "page") {
          expect(bounds(".session-glyph__badge").width).toBe(7);
        }
      }
    },
  );

  it("pauses the paired trace while queued", () => {
    const { container } = mountSolid(() => (
      <SessionGlyph content={undefined} running queued ring="pair" />
    ));
    const run = container.querySelector(".session-glyph__trace-run")!;
    expect(getComputedStyle(run).animationPlayState).toBe("paused");
  });
});
