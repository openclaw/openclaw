import { createComponent } from "solid-js";
/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { ApplicationContext } from "../app/context-types.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import {
  hasMultiplePresenceIdentities,
  projectOnlinePresenceViewers,
  type PresenceViewer,
} from "../lib/presence-users.ts";
import { profileDirectory } from "../lib/profile-directory.ts";
import { ChatAuthorAvatar } from "../pages/chat/components/chat-author-avatar-view.tsx";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { SessionOwnerAvatar } from "./solid/session-owner-chip.tsx";
import { ViewerAvatar, type ViewerFacepileProps } from "./solid/viewer-facepile.tsx";

function viewer(id: string, name: string, extra: Partial<PresenceViewer> = {}): PresenceViewer {
  return { id, name, watchedSessions: [], ...extra };
}
const avatarColor = (root: Element) =>
  root
    .querySelector<HTMLElement>(".viewer-avatar")
    ?.style.getPropertyValue("--viewer-avatar-color");

function mountAvatar(user: PresenceViewer, variant?: "session" | "profile") {
  const avatar = document.createElement("openclaw-viewer-avatar");
  Object.assign(avatar, { user, variant });
  mountSolid(() => avatar);
  return avatar;
}
function mountFacepile(props: ViewerFacepileProps) {
  const facepile = document.createElement("openclaw-viewer-facepile");
  Object.assign(facepile, props);
  mountSolid(() => facepile);
  return facepile;
}
const participant = (
  id: string,
  label: string,
  type: "profile" | "agent" = "profile",
): SessionParticipant => ({ identity: { type, id }, label });
const attr = (root: Element, selector: string, name: string) =>
  root.querySelector(selector)?.getAttribute(name);
const attrs = (root: Element, selector: string, name: string) =>
  [...root.querySelectorAll(selector)].map((element) => element.getAttribute(name));
const settle = (elements: Iterable<{ updateComplete: Promise<boolean> }>) =>
  Promise.all([...elements].map((element) => element.updateComplete));

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
});

it.each(["session", "profile"] as const)(
  "labels the shared owner avatar in %s context",
  async (variant) => {
    const avatar = mountAvatar(viewer("gateway-owner", "Saved owner name"), variant);
    await avatar.updateComplete;
    expect(avatar.querySelector(".viewer-avatar")?.getAttribute("aria-label")).toBe(
      variant === "profile" ? "Saved owner name" : "Saved owner name · Shared owner",
    );
  },
);

it("keeps identity colors consistent through avatar updates", async () => {
  const user = viewer("profile-riley", "Riley", {
    email: "riley@example.test",
    avatarUrl: "/api/users/profile-riley/avatar?v=1",
  });
  const viewerAvatar = mountAvatar(user);

  const chat = document.createElement("div");
  document.body.append(chat);
  mountSolid(
    () =>
      createComponent(ChatAuthorAvatar, {
        sender: { id: user.id, name: user.name, username: user.email },
      }),
    { container: chat },
  );

  await waitForSolid(async () => {
    await viewerAvatar.updateComplete;
    const rosterInitials = viewerAvatar.querySelector<HTMLElement>(".viewer-avatar > span");
    const chatInitials = chat.querySelector<HTMLElement>(".chat-author-avatar__initials")!;
    expect([rosterInitials?.textContent?.trim(), chatInitials.textContent?.trim()]).toEqual([
      "R",
      "R",
    ]);
    const hue = chatInitials.style.getPropertyValue("--chat-author-avatar-hue");
    expect(hue).not.toBe("");
    const color = `hsl(${hue} 48% 42%)`;
    expect(avatarColor(viewerAvatar)).toBe(color);
    const expectedStyle = document.createElement("span").style;
    expectedStyle.background = color;
    expect(rosterInitials?.style.background).toBe(expectedStyle.background);
  });
  const previousColor = avatarColor(viewerAvatar);
  const nextUser = {
    ...user,
    id: "profile-jordan",
    name: "Jordan",
    avatarUrl: "/api/users/profile-jordan/avatar?v=1",
  };
  viewerAvatar.user = nextUser;
  await viewerAvatar.updateComplete;
  expect(avatarColor(viewerAvatar)).not.toBe(previousColor);
  expect(viewerAvatar.querySelector(".viewer-avatar__initials")?.textContent).toBe("J");
});

it("keeps qualified and unqualified prepared presence faces distinct", async () => {
  const id = "c3e32452-0467-47e5-aafa-233cd5dae29f";
  const user = { id, name: "Ada Lovelace" };
  const qualifiedUser = { ...user, identity: { type: "profile" as const, id } };
  const payload = {
    presence: [qualifiedUser, user].map((presenceUser, index) => ({
      user: presenceUser,
      instanceId: `tab-${index}`,
      watchedSessions: [],
    })),
  };
  const facepile = mountFacepile({
    personActivity: { basePath: "", navigate: vi.fn() },
    staticUsers: projectOnlinePresenceViewers(payload),
  });

  await waitForSolid(async () => {
    await facepile.updateComplete;
    expect(attrs(facepile, "img", "src")).toEqual([]);
    expect(attrs(facepile, "a", "href")).toEqual(["/activity/ada-lovelace-c3e324520467"]);
    expect(attr(facepile, ".viewer-facepile", "data-viewer-count")).toBe("2");
    expect(attr(facepile, ".viewer-avatar", "aria-label")).toBe("Ada Lovelace");
    expect(facepile.querySelectorAll("openclaw-viewer-avatar")).toHaveLength(2);
  });
});

it("shares the current self avatar with typed owner faces missing a revision", async () => {
  setAvatarGatewayOrigin("https://gateway.example.test", ["viewer-token"]);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(new Blob(["avatar"], { type: "image/png" })),
  );
  vi.spyOn(URL, "createObjectURL")
    .mockReturnValueOnce("blob:shared-viewer-avatar")
    .mockReturnValueOnce("blob:updated-viewer-avatar");
  const user = {
    ...viewer("profile-ada", "Ada Lovelace"),
    identity: { type: "profile", id: "profile-ada" },
    email: "ada@example.test",
    avatarUrl: "/api/users/profile-ada/avatar?v=7",
  } satisfies PresenceViewer;
  const fixture = createApplicationGateway();
  const { gateway } = fixture;
  fixture.publish({ ...gateway.snapshot, phase: "connected", selfUser: user });
  // SAFETY: Avatar consumers use only the Gateway capability in this fixture.
  const provider = createSolidApplicationContextProvider({ gateway } as ApplicationContext);
  const view = mountSolid(
    () =>
      [user, { ...user, avatarUrl: undefined }].map((avatarUser) =>
        createComponent(ViewerAvatar, { user: avatarUser }),
      ),
    { wrapper: provider.wrapper },
  );
  const avatars = [...view.container.querySelectorAll("openclaw-viewer-avatar")];

  const sources = () => avatars.map((avatar) => attr(avatar, "img", "src"));
  await waitForSolid(() =>
    expect(sources()).toEqual(["blob:shared-viewer-avatar", "blob:shared-viewer-avatar"]),
  );

  fixture.publish({
    ...gateway.snapshot,
    selfUser: { ...user, avatarUrl: "/api/users/profile-ada/avatar?v=8" },
  });
  await waitForSolid(() =>
    expect(sources()).toEqual(["blob:shared-viewer-avatar", "blob:updated-viewer-avatar"]),
  );

  for (const identity of [
    undefined,
    { type: "agent", id: user.id },
    { type: "legacy", actorType: "human", source: null, id: user.id },
  ] as const) {
    const fallback = mountSolid(
      () =>
        createComponent(ViewerAvatar, {
          user: { ...user, identity: undefined, avatarUrl: undefined },
          identity,
        }),
      { wrapper: provider.wrapper },
    );
    const avatar = fallback.container.querySelector("openclaw-viewer-avatar")!;
    await avatar.updateComplete;
    expect(avatar.querySelector("img")).toBeNull();
  }
});

it.each(["roster", "hydrated"])("uses the %s agent emoji for owner faces", async (source) => {
  const client = createTestGatewayClient(async () => ({ agentId: "kitsune", emoji: "🦊" }));
  const gateway = createGateway(client);
  const identities = createAgentIdentityCapability(gateway);
  const context = createContext(
    gateway,
    createSessions("kitsune", []),
    {
      defaultId: "kitsune",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "kitsune", identity: source === "roster" ? { emoji: "🦊" } : undefined }],
    },
    [],
    identities,
  );
  const view = mountSolid(
    () =>
      createComponent(SessionOwnerAvatar, {
        owner: { id: "kitsune", label: "Kitsune", identity: { type: "agent", id: "kitsune" } },
      }),
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  if (source === "hydrated") {
    await identities.ensure(["kitsune"]);
  }
  await waitForSolid(() => {
    expect(attr(view.container, ".identity-avatar__text", "data-avatar")).toBe("🦊");
    expect(view.container.querySelector(".identity-avatar__agent-face")).toBeNull();
  });
});

it("renders ordered static participant actors without presence filtering", async () => {
  const facepile = mountFacepile({
    maxVisible: 2,
    staticParticipants: [
      participant("profile-ada", "Ada"),
      participant("research", "Research", "agent"),
      participant("profile-bob", "Bob"),
    ],
  });

  await waitForSolid(async () => {
    await facepile.updateComplete;
    expect(attrs(facepile, ".viewer-avatar:not(.viewer-avatar--overflow)", "aria-label")).toEqual([
      "Ada",
      "Research",
    ]);
  });
  await waitForSolid(() =>
    expect(facepile.querySelector(".identity-avatar__agent-face")).not.toBeNull(),
  );
  expect(facepile.querySelectorAll("openclaw-viewer-avatar")).toHaveLength(1);
  expect(facepile.querySelector("[data-viewer-id]")).toBeNull();
  expect(facepile.querySelector(".viewer-avatar--overflow")?.textContent?.trim()).toBe("+1");
  facepile.staticParticipants = [];
  await facepile.updateComplete;
  expect(facepile.querySelector(".viewer-facepile")).toBeNull();
});

it("excludes self, displayed owners, and participants before choosing visible avatars and overflow", async () => {
  const facepile = mountFacepile({
    selfUser: { id: "self" },
    selfInstanceId: "self-instance",
    sessionKey: "agent:main:active",
    excludeIdentities: [
      { type: "profile", id: "owner" },
      { type: "profile", id: "participant" },
    ],
    maxVisible: 2,
    presencePayload: {
      presence: [
        { instanceId: "self-instance", watchedSessions: ["agent:main:active"] },
        ...["self", "owner", "participant", "alice", "bob", "carol"].map((id) => ({
          instanceId: `${id}-second-tab`,
          user: {
            id,
            identity: id === "self" ? undefined : { type: "profile" as const, id },
            name: id,
          },
          watchedSessions: ["agent:main:active"],
        })),
      ],
    },
  });

  await waitForSolid(async () => {
    await facepile.updateComplete;
    expect(attrs(facepile, "[data-viewer-id]", "data-viewer-id")).toEqual(["alice", "bob"]);
  });
  expect(attr(facepile, ".viewer-facepile", "data-viewer-count")).toBe("3");
  expect(facepile.querySelector(".viewer-avatar--overflow")?.textContent?.trim()).toBe("+1");
  expect(facepile.querySelector('[data-viewer-id="owner"]')).toBeNull();
  expect(facepile.querySelector('[data-viewer-id="self"]')).toBeNull();
  expect(attr(facepile, ".viewer-avatar--overflow", "aria-label")).toBe("carol");
});

it("keeps collaboration UI dormant for a solo identity", () => {
  const solo = {
    presence: ["self-instance", "second-tab"].map((instanceId) => ({
      instanceId,
      user: { id: "self", name: "Self" },
      watchedSessions: ["agent:main:active"],
    })),
  };
  expect(hasMultiplePresenceIdentities(solo)).toBe(false);
  expect(
    hasMultiplePresenceIdentities({
      presence: [...solo.presence, { user: { id: "alice" }, watchedSessions: [] }],
    }),
  ).toBe(true);
});

it("keeps a newly advertised teammate avatar ahead of cached directory availability", async () => {
  setAvatarGatewayOrigin("https://gateway.example.test", ["viewer-token"]);
  const fetchAvatar = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(new Blob(["avatar"], { type: "image/png" })));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:teammate");
  const fixture = createApplicationGateway();
  const { gateway } = fixture;
  fixture.publish({
    ...gateway.snapshot,
    phase: "connected",
    hello: gatewayHelloForMethods(["users.list"], ["operator.read"]),
    client: createTestGatewayClient(async () => ({
      profiles: [
        {
          id: "teammate",
          displayName: "Teammate",
          hasAvatar: true,
          updatedAt: 7,
          createdAt: 1,
          avatarMime: null,
          mergedInto: null,
          emails: [],
          githubIdentity: null,
        },
      ],
    })),
  });
  // SAFETY: Avatar consumers use only the Gateway capability in this fixture.
  const provider = createSolidApplicationContextProvider({ gateway } as ApplicationContext);
  const user = viewer("teammate", "Teammate", {
    identity: { type: "profile", id: "teammate" },
  });
  const view = mountSolid(() => createComponent(ViewerAvatar, { user }), {
    wrapper: provider.wrapper,
  });
  const avatar = view.container.querySelector("openclaw-viewer-avatar")!;
  await avatar.updateComplete;
  await profileDirectory(gateway).load();
  avatar.user = { ...user, avatarUrl: "/api/users/teammate/avatar?v=8" };
  await avatar.updateComplete;
  await waitForSolid(() =>
    expect(fetchAvatar.mock.calls.at(-1)?.[0]).toBe(
      "https://gateway.example.test/api/users/teammate/avatar?v=8",
    ),
  );
});

it.each([false, true])(
  "keeps participant links, descriptions, and avatar identity through metadata updates (linked: %s)",
  async (linked) => {
    const navigate = vi.fn();
    const users = [participant("profile-ada", "Ada"), participant("profile-mira", "Mira")];
    const facepile = mountFacepile({
      personActivity: linked ? { basePath: "", navigate } : undefined,
      staticParticipants: users,
    });
    await facepile.updateComplete;
    const avatars = [...facepile.querySelectorAll("openclaw-viewer-avatar")];
    const avatar = avatars[0]!;
    const initials = avatar.querySelector(".viewer-avatar__initials")!;
    const links = [...facepile.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      linked ? ["/activity/profile-ada", "/activity/profile-mira"] : [],
    );
    expect(avatars).toHaveLength(2);
    const tooltips = [...facepile.querySelectorAll("openclaw-tooltip")];
    await settle(tooltips);
    for (const [index, tooltip] of tooltips.entries()) {
      const anchor = tooltip.querySelector(".viewer-facepile__tooltip-anchor")!;
      const target = linked ? links[index]! : anchor;
      const descriptionId = target.getAttribute("aria-describedby") ?? "";
      expect(document.getElementById(descriptionId)?.textContent).toBe(users[index]?.label);
      if (linked) {
        expect(anchor.hasAttribute("aria-describedby")).toBe(false);
      }
    }
    const link = links[0];
    link?.focus();
    facepile.staticParticipants = [participant("profile-ada", "Ada King"), users[1]!];
    await facepile.updateComplete;
    expect(facepile.querySelector("openclaw-viewer-avatar")).toBe(avatar);
    expect(avatar.querySelector(".viewer-avatar__initials")).toBe(initials);
    expect(attr(avatar, ".viewer-avatar", "aria-label")).toBe("Ada King");
    if (link) {
      expect(document.activeElement).toBe(link);
      link.click();
      expect(navigate).toHaveBeenCalledExactlyOnceWith("profile-ada", "Ada King");
    }
  },
);
