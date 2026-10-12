import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
/* @vitest-environment jsdom */
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { AgentIdentityAvatar } from "./identity-avatar.tsx";
import { SessionOwnerChipContent } from "./session-owner-chip.tsx";
import {
  ViewerAvatarContent,
  ViewerFacepileContent,
  type ViewerAvatarProps,
} from "./viewer-facepile.tsx";

const disposals: Array<() => void> = [];
const originalLocale = i18n.getLocale();
afterEach(async () => {
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
  await i18n.setLocale(originalLocale);
});

it("refreshes shared-owner labels without changing identity initials on locale publication", async () => {
  const user = { id: "gateway-owner", name: "Saved owner name", watchedSessions: [] };
  const view = mountSolid(() => (
    <>
      <ViewerAvatarContent user={user} />
      <ViewerFacepileContent staticUsers={[user]} />
    </>
  ));
  disposals.push(view.unmount);
  expect(view.container.querySelector(".viewer-avatar")?.getAttribute("aria-label")).toBe(
    "Shared owner",
  );
  i18n.registerTranslation("pt-BR", { presence: { sharedOwner: { name: "Dono compartilhado" } } });
  await i18n.setLocale("pt-BR");
  flush();
  expect(view.container.querySelector(".viewer-avatar")?.getAttribute("aria-label")).toBe(
    "Dono compartilhado",
  );
  expect(view.container.querySelector(".viewer-avatar__initials")?.textContent).toBe("SO");
  expect(view.container.querySelector(".viewer-facepile")?.getAttribute("aria-label")).toBe(
    "Dono compartilhado",
  );
});

it.each([false, true])(
  "retains a loaded Solid avatar through label updates (authenticated=%s)",
  async (authenticated) => {
    if (authenticated) {
      setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:solid-avatar");
    }
    const container = document.body.appendChild(document.createElement("div"));
    const [user, setUser] = createSignal<ViewerAvatarProps["user"]>({
      id: "profile-ada",
      name: "Ada",
      avatarUrl: "/api/users/profile-ada/avatar?v=1",
      watchedSessions: [],
    });
    disposals.push(mountSolid(() => <ViewerAvatarContent user={user()} />, { container }).unmount);
    const image = container.querySelector("img")!;
    expect(image).not.toBeNull();
    expect(container.querySelector(".viewer-avatar")?.classList.contains("is-pending")).toBe(true);
    if (authenticated) {
      await waitForSolid(() => expect(image.getAttribute("src")).toBe("blob:solid-avatar"));
    }
    image.dispatchEvent(new Event("load"));
    expect(container.querySelector(".viewer-avatar")?.getAttribute("data-avatar-state")).toBe(
      "loaded",
    );
    setUser((previous) => ({ ...previous!, name: "Ada Lovelace" }));
    flush();
    expect(container.querySelector("img")).toBe(image);
    expect(container.querySelector(".viewer-avatar")?.getAttribute("aria-label")).toBe(
      "Ada Lovelace",
    );
    expect(container.querySelector(".viewer-avatar")?.getAttribute("data-avatar-state")).toBe(
      "loaded",
    );
    setUser((previous) => ({ ...previous!, avatarUrl: "/api/users/profile-ada/avatar?v=2" }));
    flush();
    expect(container.querySelector("img")).toBe(image);
    expect(container.querySelector(".viewer-avatar")?.getAttribute("data-avatar-state")).toBe(
      "pending",
    );
  },
);

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
      { container },
    ).unmount,
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
      { container },
    ).unmount,
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
      { container },
    ).unmount,
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
