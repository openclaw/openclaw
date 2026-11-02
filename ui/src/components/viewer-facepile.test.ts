import { createComponent } from "solid-js";
/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { ApplicationContext } from "../app/context-types.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { resolveAvatarInitials } from "../lib/identity-avatar.ts";
import {
  hasMultiplePresenceIdentities,
  projectOnlinePresenceViewers,
  type PresenceViewer,
} from "../lib/presence-users.ts";
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

it.each([
  ["session", undefined, null, "Saved owner name · Shared owner"],
  ["profile", undefined, null, "Saved owner name"],
  ["session", "https://evil.example/avatar.png", null, "Ada Lovelace"],
  ["session", "/api/users/profile-ada/avatar", "/api/users/profile-ada/avatar", "Ada Lovelace"],
] as const)(
  "renders %s avatar labels and trusted images (%s)",
  async (variant, avatarUrl, image, label) => {
    const avatar = mountAvatar(
      {
        id: avatarUrl ? "profile-ada" : "gateway-owner",
        name: avatarUrl ? "Ada Lovelace" : "Saved owner name",
        avatarUrl,
        watchedSessions: [],
      },
      variant,
    );
    await waitForSolid(async () => {
      await avatar.updateComplete;
      expect(attr(avatar, ".viewer-avatar", "aria-label")).toBe(label);
      expect(avatar.querySelector("img")?.getAttribute("src") ?? null).toBe(image);
      if (avatarUrl) {
        expect(avatar.textContent?.trim()).toBe("AL");
      }
    });
  },
);

it.each([false, true])("keeps avatar colors through updates (photo: %s)", async (photo) => {
  const avatar = mountAvatar({ id: "initial", watchedSessions: [] });
  let previousColor: string | undefined;
  for (const name of ["Riley", "Jordan"]) {
    const user = {
      id: `profile-${name.toLowerCase()}`,
      name,
      email: "riley@example.test",
      watchedSessions: [],
      ...(photo ? { avatarUrl: `/api/users/profile-${name.toLowerCase()}/avatar?v=1` } : {}),
    };
    avatar.user = user;
    const sender = { id: user.id, name, username: user.email };
    const chat = mountSolid(() => createComponent(ChatAuthorAvatar, { sender })).container;
    const expected = resolveAvatarInitials(sender);
    const color = `hsl(${expected.colorSeed % 360} 48% 42%)`;
    await waitForSolid(async () => {
      await avatar.updateComplete;
      const initials = avatar.querySelector<HTMLElement>(".viewer-avatar > span");
      const chatInitials = chat.querySelector(".chat-author-avatar__initials");
      expect(initials?.textContent?.trim()).toBe(expected.initials);
      expect(chatInitials?.textContent?.trim()).toBe(expected.initials);
      const style = document.createElement("span").style;
      style.background = color;
      expect(initials?.style.background).toBe(style.background);
      expect(
        avatar
          .querySelector<HTMLElement>(".viewer-avatar")
          ?.style.getPropertyValue("--viewer-avatar-color"),
      ).toBe(color);
      expect(chatInitials?.getAttribute("style")).toContain(
        `--chat-author-avatar-hue: ${expected.colorSeed % 360}`,
      );
    });
    expect(color).not.toBe(previousColor);
    previousColor = color;
  }
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

it("shares cached self avatars and resolves teammate metadata only when missing", async () => {
  setAvatarGatewayOrigin("https://gateway.example.test", ["viewer-token"]);
  const fetchAvatar = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      }),
  );
  vi.spyOn(URL, "createObjectURL")
    .mockReturnValueOnce("blob:self-7")
    .mockReturnValueOnce("blob:self-8")
    .mockReturnValueOnce("blob:peer-8")
    .mockReturnValueOnce("blob:peer-7");
  const avatarUrl = (id: string, revision: number) => `/api/users/${id}/avatar?v=${revision}`;
  const user: PresenceViewer = {
    id: "self",
    identity: { type: "profile", id: "self" },
    name: "Self",
    avatarUrl: avatarUrl("self", 7),
    watchedSessions: [],
  };
  const request = vi.fn(async () => ({
    profiles: [
      {
        id: "peer",
        displayName: "Peer",
        hasAvatar: true,
        updatedAt: 7,
        createdAt: 1,
        avatarMime: null,
        mergedInto: null,
        emails: [],
        githubIdentity: null,
      },
    ],
  }));
  const context = (selfUser?: PresenceViewer) => {
    const fixture = createApplicationGateway();
    fixture.publish({
      ...fixture.gateway.snapshot,
      phase: selfUser ? "connected" : "connecting",
      selfUser,
      client: selfUser ? null : createTestGatewayClient(request),
    });
    const provider = createSolidApplicationContextProvider({
      gateway: fixture.gateway,
    } as ApplicationContext);
    const mount = (inputs: Parameters<typeof ViewerAvatar>[0][]) =>
      mountSolid(() => inputs.map((props) => createComponent(ViewerAvatar, props)), {
        wrapper: provider.wrapper,
      });
    return { ...fixture, mount };
  };
  const { gateway, publish, mount } = context(user);
  const images = (nodes: Element[]) =>
    nodes.map((avatar) => avatar.querySelector("img")?.getAttribute("src"));
  const view = mount([
    { user },
    { user: { ...user, avatarUrl: undefined } },
    ...(
      [
        undefined,
        { type: "agent", id: user.id },
        { type: "legacy", actorType: "human", source: null, id: user.id },
      ] as const
    ).map((identity) => ({
      user: { ...user, identity: undefined, avatarUrl: undefined },
      identity,
    })),
  ]);
  const avatars = [...view.container.querySelectorAll("openclaw-viewer-avatar")];
  await waitForSolid(() =>
    expect(images(avatars).slice(0, 2)).toEqual(["blob:self-7", "blob:self-7"]),
  );
  expect(fetchAvatar).toHaveBeenCalledExactlyOnceWith(
    "https://gateway.example.test/api/users/self/avatar?v=7",
    expect.objectContaining({ headers: { Authorization: "Bearer viewer-token" } }),
  );
  for (const avatar of avatars.slice(0, 2)) {
    avatar.querySelector("img")?.dispatchEvent(new Event("load"));
    expect(avatar.querySelector(".viewer-avatar")?.classList.contains("is-fallback")).toBe(false);
  }
  publish({ ...gateway.snapshot, selfUser: { ...user, avatarUrl: avatarUrl("self", 8) } });
  await waitForSolid(() =>
    expect(images(avatars).slice(0, 2)).toEqual(["blob:self-7", "blob:self-8"]),
  );
  expect(images(avatars).slice(2)).toEqual([undefined, undefined, undefined]);
  expect(fetchAvatar).toHaveBeenCalledTimes(2);
  view.unmount();
  const peerContext = context();
  const peer = {
    ...user,
    id: "peer",
    identity: { type: "profile" as const, id: "peer" },
    avatarUrl: avatarUrl("peer", 8),
  };
  const peerView = peerContext.mount([{ user: peer }]);
  const peers = [...peerView.container.querySelectorAll("openclaw-viewer-avatar")];
  await settle(peers);
  peerContext.publish({
    ...peerContext.gateway.snapshot,
    phase: "connected",
    hello: gatewayHelloForMethods(["users.list"], ["operator.read"]),
  });
  await settle(peers);
  await waitForSolid(() => expect(images(peers)).toEqual(["blob:peer-8"]));
  expect(request).not.toHaveBeenCalled();
  peers[0]!.user = { ...peer, avatarUrl: undefined };
  await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
  await waitForSolid(() => expect(images(peers)).toEqual(["blob:peer-7"]));
  expect(fetchAvatar.mock.calls.map(([url]) => url)).toEqual([
    "https://gateway.example.test/api/users/self/avatar?v=7",
    "https://gateway.example.test/api/users/self/avatar?v=8",
    "https://gateway.example.test/api/users/peer/avatar?v=8",
    "https://gateway.example.test/api/users/peer/avatar?v=7",
  ]);
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
    expect(facepile.querySelector(".identity-avatar__agent-face")).not.toBeNull();
  });
  expect(facepile.querySelectorAll("openclaw-viewer-avatar")).toHaveLength(1);
  expect(facepile.querySelector("[data-viewer-id]")).toBeNull();
  expect(facepile.querySelector(".viewer-avatar--overflow")?.textContent?.trim()).toBe("+1");
  facepile.staticParticipants = [];
  await facepile.updateComplete;
  expect(facepile.querySelector(".viewer-facepile")).toBeNull();
});

it("excludes displayed owners and participants before choosing visible avatars and overflow", async () => {
  const facepile = mountFacepile({
    sessionKey: "agent:main:active",
    excludeIdentities: [
      { type: "profile", id: "owner" },
      { type: "profile", id: "participant" },
    ],
    maxVisible: 2,
    presencePayload: {
      presence: ["owner", "participant", "alice", "bob", "carol"].map((id) => ({
        instanceId: `${id}-instance`,
        user: { id, identity: { type: "profile", id }, name: id },
        watchedSessions: ["agent:main:active"],
      })),
    },
  });

  await waitForSolid(async () => {
    await facepile.updateComplete;
    expect(attrs(facepile, "[data-viewer-id]", "data-viewer-id")).toEqual(["alice", "bob"]);
  });
  expect(attr(facepile, ".viewer-facepile", "data-viewer-count")).toBe("3");
  expect(facepile.querySelector(".viewer-avatar--overflow")?.textContent?.trim()).toBe("+1");
  expect(facepile.querySelector('[data-viewer-id="owner"]')).toBeNull();
  expect(attr(facepile, ".viewer-avatar--overflow", "aria-label")).toBe("carol");
});

it("deduplicates solo tabs and excludes self when the browser row lacks a user id", async () => {
  const watchedSessions = ["agent:main:active"];
  const selfTabs = ["self-instance", "self-second-tab"].map((instanceId) => ({
    instanceId,
    user: { id: "self", name: "Self" },
    watchedSessions,
  }));
  const other = { user: { id: "alice", name: "Alice" }, watchedSessions: [] };
  expect(hasMultiplePresenceIdentities({ presence: selfTabs })).toBe(false);
  expect(hasMultiplePresenceIdentities({ presence: [...selfTabs, other] })).toBe(true);
  const facepile = mountFacepile({
    selfUser: { id: "self" },
    selfInstanceId: "self-instance",
    sessionKey: "agent:main:active",
    presencePayload: {
      presence: [{ ...selfTabs[0], user: undefined }, selfTabs[1], { ...other, watchedSessions }],
    },
  });

  await waitForSolid(async () => {
    await facepile.updateComplete;
    expect(facepile.querySelector('[data-viewer-id="self"]')).toBeNull();
    expect(facepile.querySelector('[data-viewer-id="alice"]')).not.toBeNull();
  });
});

it.each([false, true])(
  "retains accessible participant faces across metadata updates (linked: %s)",
  async (linked) => {
    const navigate = vi.fn();
    const users = [participant("profile-ada", "Ada King"), participant("profile-mira", "Mira")];
    const facepile = mountFacepile({
      staticParticipants: users,
      personActivity: linked ? { basePath: "", navigate } : undefined,
    });
    await facepile.updateComplete;
    expect(attrs(facepile, "a", "href")).toEqual(
      linked ? ["/activity/profile-ada", "/activity/profile-mira"] : [],
    );
    expect(facepile.querySelectorAll("openclaw-viewer-avatar")).toHaveLength(2);
    const tooltips = [...facepile.querySelectorAll("openclaw-tooltip")];
    await settle(tooltips);
    for (const [index, tooltip] of tooltips.entries()) {
      const anchor = tooltip.querySelector(linked ? "a" : ".viewer-facepile__tooltip-anchor");
      expect(
        document.getElementById(anchor?.getAttribute("aria-describedby") ?? "")?.textContent,
      ).toBe(users[index]?.label);
      expect(
        tooltip.querySelector(".viewer-facepile__tooltip-anchor")?.hasAttribute("aria-describedby"),
      ).toBe(!linked);
    }
    const avatar = facepile.querySelector("openclaw-viewer-avatar")!;
    const initials = avatar.querySelector(".viewer-avatar__initials")!;
    const link = facepile.querySelector<HTMLAnchorElement>("a");
    link?.focus();
    facepile.staticParticipants = [participant("profile-ada", "Ada Byron"), users[1]!];
    await facepile.updateComplete;
    expect(facepile.querySelector("openclaw-viewer-avatar")).toBe(avatar);
    expect(avatar.querySelector(".viewer-avatar__initials")).toBe(initials);
    expect(attr(avatar, ".viewer-avatar", "aria-label")).toBe("Ada Byron");
    if (link) {
      expect(document.activeElement).toBe(link);
      link.click();
      expect(navigate).toHaveBeenCalledExactlyOnceWith("profile-ada", "Ada Byron");
    }
  },
);
