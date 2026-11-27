import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import "../test-helpers/load-styles.ts";
import "../styles/sidebar-rail.css";
import "../styles/sidebar-agent-roster.css";
import { projectSidebarSession } from "./app-sidebar-session-navigation.test-support.ts";
import { Icon } from "./solid/icon.tsx";
import { SessionOwnerChip } from "./solid/session-owner-chip.tsx";
import {
  SessionGlyph,
  TeamSessionSlots,
  renderSessionLeadingState,
  renderSessionUnreadBadge,
} from "./solid/session-presentation.tsx";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

afterEach(() => {
  document.body.replaceChildren();
});

describe.skipIf(!hasBrowserLayout)("sidebar glyph geometry", () => {
  it("keeps attention artwork compact in Team slots", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const row = {
      ...projectSidebarSession({ key: "agent:main:attention-geometry" }),
      attention: {
        kind: "error" as const,
        reason: "Synthetic failure",
        sourceSessionKey: "agent:main:attention-geometry",
      },
    };
    mountSolid(
      () => (
        <>
          {renderSessionLeadingState({ session: row, attribution: "owned" }).leadingIndicator}
          <TeamSessionSlots rows={[row]} includeChildren={false} childCount={0} />
        </>
      ),
      { container: host },
    );
    flush();
    const regular = host.querySelector(".session-glyph .sidebar-session-attention__icon > *")!;
    const compact = host.querySelector(
      ".sidebar-session-team-state .sidebar-session-attention__icon > *",
    )!;
    expect(regular.getBoundingClientRect().width).toBe(15);
    expect(compact.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(compact.getBoundingClientRect().width).toBeLessThan(
      regular.getBoundingClientRect().width,
    );
  });

  it("preserves named glyph sizes in rows and the collapsed rail", () => {
    const host = document.body.appendChild(document.createElement("div"));
    mountSolid(
      () =>
        renderSessionLeadingState({
          session: projectSidebarSession({ key: "agent:main:geometry", icon: "kanban" }),
          attribution: "owned",
        }).leadingIndicator,
      { container: host },
    );
    flush();
    const artwork = host.querySelector(".session-glyph__icon > *");
    expect(artwork).not.toBeNull();
    for (const rail of [false, true]) {
      host.className = rail ? "sidebar-rail" : "";
      const { width, height } = artwork!.getBoundingClientRect();
      expect([width, height]).toEqual(rail ? [19, 19] : [16, 16]);
    }
  });

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
        expect(ringStyle.width).toBe(ringStyle.height);
        expect(Number.parseFloat(ringStyle.width)).toBeGreaterThan(artwork.width);
        expect(ring.x + ring.width / 2).toBeCloseTo(slot.x + slot.width / 2, 3);
        expect(ring.y + ring.height / 2).toBeCloseTo(slot.y + slot.height / 2, 3);
        if (kind === "page") {
          expect(bounds(".session-glyph__badge").width).toBeGreaterThan(0);
          expect(bounds(".session-glyph__badge").width).toBeLessThan(slot.width);
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
