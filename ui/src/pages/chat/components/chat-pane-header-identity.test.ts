/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatPaneHeaderSessionRow as row,
  mountChatPaneHeader,
  type ChatPaneHeaderProps,
} from "./chat-pane-header.test-support.ts";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
});

function mountHeader(patch: Partial<ChatPaneHeaderProps> = {}) {
  return mountChatPaneHeader(containers, patch);
}

describe("chat pane header identity links", () => {
  it("opens owner assignment while keeping participant activity links", async () => {
    const navigate = vi.fn();
    const assignOwner = vi.fn();
    const { container } = mountHeader({
      showOwnerChip: true,
      onAssignOwner: assignOwner,
      personActivity: { basePath: "", navigate },
      session: row({
        owner: {
          actor: {
            type: "human",
            id: "ada",
            identity: { type: "profile", id: "ada" },
            label: "Ada King",
          },
        },
        participants: [
          { identity: { type: "profile", id: "mira" }, label: "Mira" },
          { identity: { type: "profile", id: "riley" }, label: "Riley" },
        ],
        participantCount: 2,
      }),
    });

    const facepile = container.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
      "openclaw-viewer-facepile.chat-pane__participants",
    );
    await facepile?.updateComplete;
    const ownerControl = container.querySelector<HTMLButtonElement>("button.chat-pane__owner");
    expect(ownerControl?.getAttribute("aria-label")).toBe("Owner: Ada King");
    const participantLinks = [
      ...container.querySelectorAll<HTMLAnchorElement>(
        ".chat-pane__participants a.person-activity-avatar-link",
      ),
    ];
    expect(participantLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/activity/mira",
      "/activity/riley",
    ]);

    ownerControl?.click();
    expect(assignOwner).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("leaves identities unlinked when the header has no activity routing", () => {
    const { container } = mountHeader({
      showOwnerChip: true,
      session: row({
        owner: {
          actor: {
            type: "human",
            id: "ada",
            identity: { type: "profile", id: "ada" },
            label: "Ada King",
          },
        },
        participants: [{ identity: { type: "profile", id: "mira" }, label: "Mira" }],
        participantCount: 1,
      }),
    });

    expect(container.querySelector("a.person-activity-avatar-link")).toBeNull();
    expect(container.querySelector("openclaw-session-owner-chip")).not.toBeNull();
    expect(container.querySelector("button.chat-pane__owner")).toBeNull();
    expect(container.querySelector(".chat-pane__owner")?.textContent).toContain("Owner:");
  });
});
