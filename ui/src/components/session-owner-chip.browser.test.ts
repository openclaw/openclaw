import { afterEach, describe, expect, it } from "vitest";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import "../test-helpers/load-styles.ts";
import type { SessionCreatedActor } from "./session-owner-chip.ts";
import "./session-owner-chip.ts";

type OwnerChipElement = HTMLElement & {
  owner: SessionCreatedActor | null;
  participants: readonly SessionParticipant[];
  participantCount: number;
  size: "row" | "header";
  updateComplete: Promise<boolean>;
};

const originalTheme = document.documentElement.getAttribute("data-theme-mode");
const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

afterEach(() => {
  document.body.replaceChildren();
  if (originalTheme === null) {
    document.documentElement.removeAttribute("data-theme-mode");
  } else {
    document.documentElement.setAttribute("data-theme-mode", originalTheme);
  }
});

async function mountOwnerChip(params: {
  participants?: readonly SessionParticipant[];
  participantCount?: number;
}) {
  // SAFETY: the imported module registers this custom element with these reactive properties.
  const chip = document.createElement("openclaw-session-owner-chip") as OwnerChipElement;
  chip.owner = { type: "human", id: "profile-ada", label: "Ada" };
  chip.size = "row";
  chip.participants = params.participants ?? [];
  chip.participantCount = params.participantCount ?? chip.participants.length;
  document.body.append(chip);
  await chip.updateComplete;
  return chip;
}

describe.skipIf(!hasBrowserLayout)("session owner stack layout", () => {
  it.each([
    {
      backSelector: ".session-owner-stack__back .viewer-avatar",
      name: "one participant avatar",
      participantCount: 1,
      participants: [{ identity: { type: "profile" as const, id: "profile-bob" }, label: "Bob" }],
    },
    {
      backSelector: ".session-owner-stack__overflow",
      name: "participant overflow",
      participantCount: 2,
      participants: [
        { identity: { type: "profile" as const, id: "profile-bob" }, label: "Bob" },
        { identity: { type: "agent" as const, id: "research" }, label: "Research" },
      ],
    },
  ])("fits $name diagonally inside the single-owner footprint", async (fixture) => {
    const chip = await mountOwnerChip(fixture);
    const stack = chip.querySelector<HTMLElement>(".session-owner-stack");
    const back = chip.querySelector<HTMLElement>(fixture.backSelector);
    const front = chip.querySelector<HTMLElement>(".session-owner-stack__front");
    if (!stack || !back || !front) {
      throw new Error("expected complete session owner stack");
    }

    const stackBounds = stack.getBoundingClientRect();
    const backBounds = back.getBoundingClientRect();
    const frontBounds = front.getBoundingClientRect();
    expect({
      backSize: [backBounds.width, backBounds.height],
      frontSize: [frontBounds.width, frontBounds.height],
      stackSize: [stackBounds.width, stackBounds.height],
    }).toEqual({
      backSize: [12, 12],
      frontSize: [14, 14],
      stackSize: [20, 20],
    });
    expect(backBounds.top).toBeLessThan(frontBounds.top);
    expect(backBounds.left).toBeLessThan(frontBounds.left);
    expect(backBounds.right).toBeGreaterThan(frontBounds.left);
    // Both circular faces must fit the same 20px disc as a single owner, not
    // merely its square bounding box (which would let the ring cross a face).
    for (const bounds of [backBounds, frontBounds]) {
      const centerDistance = Math.hypot(
        bounds.x + bounds.width / 2 - (stackBounds.x + stackBounds.width / 2),
        bounds.y + bounds.height / 2 - (stackBounds.y + stackBounds.height / 2),
      );
      expect(centerDistance + bounds.width / 2).toBeLessThanOrEqual(10.05);
    }
  });

  it("keeps the single-owner row avatar at its established size", async () => {
    const chip = await mountOwnerChip({});
    const owner = chip.querySelector<HTMLElement>(".session-owner-chip--row");
    if (!owner) {
      throw new Error("expected single owner row avatar");
    }
    const bounds = owner.getBoundingClientRect();
    expect([bounds.width, bounds.height]).toEqual([20, 20]);
    expect(chip.querySelector(".session-owner-stack")).toBeNull();
  });

  it.each(
    ["light", "dark"].flatMap((theme) =>
      [0, 1, 2].map((participantCount) => ({ theme, participantCount })),
    ),
  )(
    "uses a thin cutout only for stacked owners in $theme with $participantCount participants",
    async ({ theme, participantCount }) => {
      document.documentElement.setAttribute("data-theme-mode", theme);
      const sidebar = document.createElement("aside");
      sidebar.className = "sidebar";
      document.body.append(sidebar);
      const chip = await mountOwnerChip({
        participantCount,
        participants: [{ identity: { type: "profile", id: "profile-bob" }, label: "Bob" }],
      });
      const row = document.createElement("div");
      row.className = "sidebar-recent-session";
      row.style.transition = "none";
      sidebar.append(row);
      row.append(chip);
      const front = chip.querySelector<HTMLElement>(".session-owner-chip")!;
      if (participantCount === 0) {
        expect(getComputedStyle(front).borderTopWidth).toBe("0px");
        expect(getComputedStyle(front).boxShadow).toBe("none");
        return;
      }
      const stack = chip.querySelector<HTMLElement>(".session-owner-stack")!;
      for (const selected of [false, true]) {
        row.classList.toggle("sidebar-recent-session--selected", selected);
        await expect
          .poll(() =>
            [getComputedStyle(stack, "::before"), getComputedStyle(stack, "::after")].map(
              (cutout) => ({
                width: cutout.borderTopWidth,
                matchesRow: cutout.borderTopColor === getComputedStyle(row).backgroundColor,
              }),
            ),
          )
          .toEqual([
            { width: "1px", matchesRow: true },
            { width: "1px", matchesRow: true },
          ]);
      }
    },
  );
});
