import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { i18n } from "../../../i18n/index.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { emulateOverlayMedia } from "../../../test-helpers/overlay-browser-media.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
// Warm the lazy menu body so opening reaches the member section, not the content fallback.
import "./chat-session-sharing-content.tsx";
import type { ChatSessionSharingProps } from "./chat-session-sharing-shared.tsx";
import { ChatSessionSharing } from "./chat-session-sharing.solid.tsx";

const session = {
  key: "agent:main:main",
  kind: "direct" as const,
  updatedAt: 1,
  visibility: "shared" as const,
  sharingRole: "owner" as const,
};
const result = {
  sessionKey: "agent:main:main",
  members: [],
  identities: [{ type: "human" as const, id: "alice", label: "Alice" }],
  role: "owner" as const,
  allowedVisibilities: ["shared" as const],
};

let container: HTMLDivElement | undefined;
afterEach(async () => {
  container?.remove();
  container = undefined;
  await emulateOverlayMedia({ reducedMotion: "no-preference" });
});

async function openPendingMembers() {
  await i18n.setLocale("en");
  const read = createDeferred();
  const base = {
    session,
    onOpen: vi.fn(),
    onVisibilityChange: vi.fn(),
    onMemberChange: vi.fn(),
  } satisfies Partial<ChatSessionSharingProps>;
  const [props, setProps] = createSignal<ChatSessionSharingProps>({
    ...base,
    state: { loading: false, read: read.promise },
  });
  container = document.body.appendChild(document.createElement("div"));
  mountSolid(() => <ChatSessionSharing {...props()} />, { container });
  flush();
  const root = container;
  root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")!.click();
  await waitForSolid(() =>
    expect(root.querySelectorAll(".chat-pane__sharing-member-skeleton")).toHaveLength(3),
  );
  const settle = async () => {
    setProps({ ...base, state: { loading: false, result } });
    read.resolve();
    await waitForSolid(() =>
      expect(root.querySelector('button[data-value="member:alice"]')).not.toBeNull(),
    );
    expect(root.querySelector(".chat-pane__sharing-member-skeleton")).toBeNull();
    expect(root.querySelector(".chat-pane__sharing-members-loading")).toBeNull();
  };
  return { root, settle };
}

// Samples each row's reveal clock so assertions do not depend on wall-clock timing.
function revealFrames(root: HTMLElement, times: number[]) {
  const rows = [...root.querySelectorAll<HTMLElement>(".chat-pane__sharing-member-skeleton")];
  const animations = rows.map((row) => {
    const animation = row
      .getAnimations()
      .find(
        (entry) => entry instanceof CSSAnimation && entry.animationName === "chat-skeleton-reveal",
      );
    if (!animation) {
      throw new Error("The member skeleton has no reveal animation");
    }
    animation.pause();
    return { row, animation };
  });
  return times.map((time) =>
    animations.map(({ row, animation }) => {
      animation.currentTime = time;
      const style = getComputedStyle(row);
      return { opacity: Number(style.opacity), visibility: style.visibility };
    }),
  );
}

describe("session sharing member skeletons", () => {
  it("reveals placeholder rows after 150 ms while the busy label stays visible", async () => {
    const { root, settle } = await openPendingMembers();
    const status = root.querySelector<HTMLElement>(".chat-pane__sharing-members-loading")!;
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.getAttribute("aria-label")).toBe("Loading…");
    expect(getComputedStyle(status).visibility).toBe("visible");

    const [initial, waiting, fading, revealed] = revealFrames(root, [0, 149, 225, 300]);
    for (const frame of [initial, waiting]) {
      expect(frame).toEqual(Array(3).fill({ opacity: 0, visibility: "hidden" }));
    }
    for (const row of fading!) {
      expect(row.opacity).toBeGreaterThan(0);
      expect(row.opacity).toBeLessThan(1);
    }
    expect(revealed).toEqual(Array(3).fill({ opacity: 1, visibility: "visible" }));

    await settle();
  });

  it("replaces still-hidden rows with members when the read settles inside the delay", async () => {
    const { root, settle } = await openPendingMembers();
    for (const row of root.querySelectorAll<HTMLElement>(".chat-pane__sharing-member-skeleton")) {
      expect(getComputedStyle(row).visibility).toBe("hidden");
    }
    await settle();
  });

  it("keeps the reveal delay under reduced motion and drops only the fade", async () => {
    await emulateOverlayMedia({ reducedMotion: "reduce" });
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    const { root, settle } = await openPendingMembers();

    const [waiting, revealed] = revealFrames(root, [149, 151]);
    expect(waiting).toEqual(Array(3).fill({ opacity: 0, visibility: "hidden" }));
    expect(revealed).toEqual(Array(3).fill({ opacity: 1, visibility: "visible" }));

    await settle();
  });
});
