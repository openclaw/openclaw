/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import {
  chatPaneHeaderSessionRow as row,
  mountChatPaneHeader,
} from "./chat-pane-header.test-support.ts";

const containers: HTMLElement[] = [];

afterEach(() => containers.splice(0).forEach((container) => container.remove()));

const participant = (id: string, label: string) => ({
  identity: { type: "profile" as const, id },
  label,
});
const owner = {
  actor: { type: "human", id: "ada", ...participant("ada", "Ada King") },
} satisfies NonNullable<ReturnType<typeof row>["owner"]>;

it.each([true, false])(
  "links owner and participant identities only with activity routing (%s)",
  async (routing) => {
    const navigate = vi.fn();
    const participants = [participant("mira", "Mira")];
    if (routing) {
      participants.push(participant("riley", "Riley"));
    }
    const { container } = mountChatPaneHeader(containers, {
      showOwnerChip: true,
      personActivity: routing ? { basePath: "", navigate } : undefined,
      session: row({
        owner,
        participants,
        participantCount: participants.length,
      }),
    });
    if (!routing) {
      expect(container.querySelector("a.person-activity-avatar-link")).toBeNull();
      expect(container.querySelector("openclaw-session-owner-chip")).not.toBeNull();
      return;
    }
    const facepile = container.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
      "openclaw-viewer-facepile.chat-pane__participants",
    );
    await facepile?.updateComplete;
    const ownerLink = container.querySelector<HTMLAnchorElement>(
      "a.person-activity-avatar-link:has(openclaw-session-owner-chip)",
    );
    expect(ownerLink?.getAttribute("href")).toBe("/activity/ada");
    const links = container.querySelectorAll(
      ".chat-pane__participants a.person-activity-avatar-link",
    );
    expect(Array.from(links, (link) => link.getAttribute("href"))).toEqual([
      "/activity/mira",
      "/activity/riley",
    ]);

    ownerLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledWith("ada", "Ada King");
  },
);

it("retains the rename control and focus while header facts and callbacks update", () => {
  const previousRename = vi.fn();
  const currentRename = vi.fn();
  const { container, update } = mountChatPaneHeader(containers, {
    onBeginRename: previousRename,
  });
  const button = container.querySelector<HTMLButtonElement>(".chat-pane__session-title-button")!;
  const title = button.querySelector(".chat-pane__session-title-text");
  button.focus();
  update({ title: "Current session", onBeginRename: currentRename, ownerViewing: true });
  expect(container.querySelector(".chat-pane__session-title-button")).toBe(button);
  expect(button.querySelector(".chat-pane__session-title-text")).toBe(title);
  expect(button.textContent).toBe("Current session");
  expect(document.activeElement).toBe(button);
  button.click();
  expect(currentRename).toHaveBeenCalledOnce();
  expect(previousRename).not.toHaveBeenCalled();
});
