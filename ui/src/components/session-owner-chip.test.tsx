/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import {
  SessionOwnerChipContent,
  type SessionOwnerChipProps,
} from "./solid/session-owner-chip.tsx";

const disposals: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
});

function mount(params: { participants?: SessionParticipant[]; participantCount?: number }) {
  const chip = document.body.appendChild(document.createElement("div"));
  const [owner, setOwner] = createSignal<NonNullable<SessionOwnerChipProps["owner"]>>({
    type: "human",
    id: "profile-ada",
    label: "Ada",
  });
  const [size, setSize] = createSignal<SessionOwnerChipProps["size"]>("row");
  const participants = params.participants ?? [];
  disposals.push(
    mountSolid(
      () => (
        <SessionOwnerChipContent
          owner={owner()}
          attribution="owned"
          size={size()}
          participants={participants}
          participantCount={params.participantCount ?? participants.length}
        />
      ),
      { container: chip },
    ).unmount,
  );
  flush();
  expect(chip.querySelector(".session-owner-chip")).not.toBeNull();
  return { chip, setOwner, setSize };
}

it("keeps the single owner chip unchanged without participants", () => {
  const { chip } = mount({});
  expect(chip.querySelector(".session-owner-stack")).toBeNull();
  expect(chip.querySelectorAll(".session-owner-chip")).toHaveLength(1);
  expect(chip.querySelector(".session-owner-chip")?.getAttribute("aria-label")).toBe(
    "Owned by Ada",
  );
});

it("renders one participant behind the owner with combined accessibility", () => {
  const { chip } = mount({
    participants: [
      {
        identity: { type: "agent", id: "research" },
        label: "Research",
        avatarUrl: "/avatar/research",
      },
    ],
    participantCount: 1,
  });
  expect(chip.querySelector(".session-owner-stack__back .viewer-avatar")).not.toBeNull();
  expect(chip.querySelector(".session-owner-stack__front")).not.toBeNull();
  expect(chip.querySelector(".session-owner-stack")?.getAttribute("aria-label")).toBe(
    "Owned by Ada · with Research",
  );
  expect(chip.querySelector(".session-owner-stack__back img")?.getAttribute("src")).toBe(
    "/avatar/research",
  );
});

it.each(["row", "header"] as const)(
  "renders the agent picture and generated fallback in a %s owner chip",
  async (size) => {
    const { chip, setOwner, setSize } = mount({});
    setOwner({
      type: "agent",
      id: "research",
      identity: { type: "agent", id: "research" },
      label: "Research",
      avatarUrl: "/avatar/research",
    });
    setSize(size);
    flush();
    expect(chip.querySelector(".session-owner-chip img")?.getAttribute("src")).toBe(
      "/avatar/research",
    );
    chip.querySelector("img")?.dispatchEvent(new Event("error"));
    await vi.waitFor(() =>
      expect(chip.querySelector(".identity-avatar__agent-face")).not.toBeNull(),
    );
    expect(chip.querySelector(".identity-avatar--agent")?.classList.contains("is-fallback")).toBe(
      true,
    );
    setOwner((previous) => ({ ...previous, avatarUrl: undefined }));
    flush();
    await vi.waitFor(() =>
      expect(chip.querySelector(".identity-avatar__agent-face")).not.toBeNull(),
    );
  },
);

it("renders the total participant count in the back slot for three identities", () => {
  const { chip } = mount({
    participants: [
      { identity: { type: "profile", id: "profile-bob" }, label: "Bob" },
      { identity: { type: "agent", id: "research" }, label: "Research" },
    ],
    participantCount: 2,
  });
  expect(chip.querySelector(".session-owner-stack__overflow")?.textContent).toBe("+2");
  expect(chip.querySelector(".session-owner-stack")?.getAttribute("aria-label")).toBe(
    "Owned by Ada · +2 more",
  );
});
