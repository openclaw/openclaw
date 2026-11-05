/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { SessionOwnerChip, type SessionOwnerChipProps } from "./solid/session-owner-chip.tsx";

afterEach(() => {
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
});

function mount(participants: SessionParticipant[] = []) {
  const [owner, setOwner] = createSignal<NonNullable<SessionOwnerChipProps["owner"]>>({
    type: "human",
    id: "profile-ada",
    label: "Ada",
  });
  const { container: chip } = mountSolid(() => (
    <SessionOwnerChip
      owner={owner()}
      attribution="owned"
      participants={participants}
      participantCount={participants.length}
    />
  ));
  flush();
  expect(chip.querySelector(".session-owner-chip")).not.toBeNull();
  return { setOwner, find: (selector: string) => chip.querySelector(selector) };
}

it("renders one participant behind the owner with combined accessibility", () => {
  const { find } = mount([
    {
      identity: { type: "agent", id: "research" },
      label: "Research",
      avatarUrl: "/avatar/research",
    },
  ]);
  expect(find(".session-owner-stack")?.getAttribute("aria-label")).toBe(
    "Owned by Ada · with Research",
  );
  expect(find(".session-owner-stack__back img")?.getAttribute("src")).toBe("/avatar/research");
});

it("renders the agent picture and generated fallback in an owner chip", async () => {
  const { find, setOwner } = mount();
  setOwner({
    type: "agent",
    id: "research",
    identity: { type: "agent", id: "research" },
    label: "Research",
    avatarUrl: "/avatar/research",
  });
  flush();
  expect(find(".session-owner-chip img")?.getAttribute("src")).toBe("/avatar/research");
  find("img")?.dispatchEvent(new Event("error"));
  await vi.waitFor(() => expect(find(".identity-avatar__agent-face")).not.toBeNull());
  expect(find(".identity-avatar--agent")?.classList.contains("is-fallback")).toBe(true);
  setOwner((previous) => ({ ...previous, avatarUrl: undefined }));
  flush();
  await vi.waitFor(() => expect(find(".identity-avatar__agent-face")).not.toBeNull());
});
