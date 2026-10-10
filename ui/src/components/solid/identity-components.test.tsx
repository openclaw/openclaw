/* @vitest-environment jsdom */
import { render as mountSolid } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { AgentIdentityAvatar } from "./identity-avatar.tsx";
import { SessionOwnerChipContent } from "./session-owner-chip.tsx";
import {
  ViewerAvatarContent,
  ViewerFacepileContent,
  type ViewerAvatarProps,
} from "./viewer-facepile.tsx";

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
});

it("retains a loaded Solid avatar while its label changes and resets for a new revision", () => {
  const container = document.body.appendChild(document.createElement("div"));
  const [user, setUser] = createSignal<ViewerAvatarProps["user"]>({
    id: "profile-ada",
    name: "Ada",
    avatarUrl: "/api/users/profile-ada/avatar?v=1",
    watchedSessions: [],
  });
  disposals.push(mountSolid(() => <ViewerAvatarContent user={user()} />, container));
  const image = container.querySelector("img")!;
  image.dispatchEvent(new Event("load"));
  expect(container.querySelector(".viewer-avatar")?.getAttribute("data-avatar-state")).toBe(
    "loaded",
  );
  setUser({ ...user()!, name: "Ada Lovelace" });
  flush();
  expect(container.querySelector("img")).toBe(image);
  expect(container.querySelector(".viewer-avatar")?.getAttribute("aria-label")).toBe(
    "Ada Lovelace",
  );
  expect(container.querySelector(".viewer-avatar")?.getAttribute("data-avatar-state")).toBe(
    "loaded",
  );
  setUser({ ...user()!, avatarUrl: "/api/users/profile-ada/avatar?v=2" });
  flush();
  expect(container.querySelector("img")).toBe(image);
  expect(container.querySelector(".viewer-avatar")?.getAttribute("data-avatar-state")).toBe(
    "pending",
  );
});

it("updates Solid owner attribution and participant stacks from the current props", () => {
  const container = document.body.appendChild(document.createElement("div"));
  const [count, setCount] = createSignal(0);
  disposals.push(
    mountSolid(
      () => (
        <SessionOwnerChipContent
          owner={{ type: "human", id: "ada", label: "Ada" }}
          attribution="owned"
          participantCount={count()}
          participants={[{ identity: { type: "profile", id: "bob" }, label: "Bob" }]}
        />
      ),
      container,
    ),
  );
  expect(container.querySelector(".session-owner-stack")).toBeNull();
  setCount(1);
  flush();
  expect(container.querySelector(".session-owner-stack")?.getAttribute("aria-label")).toBe(
    "Owned by Ada · with Bob",
  );
  setCount(3);
  flush();
  expect(container.querySelector(".session-owner-stack__count")?.textContent).toBe("+3");
});

it("keeps the namespace when profile and agent participants share an id", () => {
  const container = document.body.appendChild(document.createElement("div"));
  disposals.push(
    mountSolid(
      () => (
        <ViewerFacepileContent
          staticParticipants={[
            { identity: { type: "profile", id: "same" }, label: "Ada" },
            { identity: { type: "agent", id: "same" }, label: "Research" },
          ]}
        />
      ),
      container,
    ),
  );
  expect(container.querySelectorAll("openclaw-tooltip")).toHaveLength(2);
  expect(container.querySelector(".identity-avatar--agent")).not.toBeNull();
  expect(container.querySelector("[data-viewer-id]")).toBeNull();
});

it("renders and retires a Solid agent's configured image without losing its fallback", () => {
  const container = document.body.appendChild(document.createElement("div"));
  const [avatar, setAvatar] = createSignal<string | undefined>("/avatar/research");
  disposals.push(
    mountSolid(
      () => <AgentIdentityAvatar agent={{ id: "research", avatar: avatar(), textAvatar: "🦀" }} />,
      container,
    ),
  );
  container.querySelector("img")!.dispatchEvent(new Event("error"));
  expect(
    container.querySelector(".identity-avatar--agent")?.classList.contains("is-fallback"),
  ).toBe(true);
  setAvatar(undefined);
  flush();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("🦀");
});
