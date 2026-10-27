import { createComponent } from "solid-js";
/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { ApplicationContext } from "../app/context-types.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import { resolveAvatarInitials } from "../lib/identity-avatar.ts";
import {
  hasMultiplePresenceIdentities,
  projectOnlinePresenceViewers,
  projectPresencePayload,
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

it.each(["session", "profile"] as const)(
  "labels the shared owner avatar in %s context",
  async (variant) => {
    const avatar = mountAvatar(
      { id: "gateway-owner", name: "Saved owner name", watchedSessions: [] },
      variant,
    );
    await avatar.updateComplete;
    expect(avatar.querySelector(".viewer-avatar")?.getAttribute("aria-label")).toBe(
      variant === "profile" ? "Saved owner name" : "Saved owner name · Shared owner",
    );
  },
);

it.each([false, true])(
  "keeps identity colors consistent through avatar updates (photo: %s)",
  async (photo) => {
    const user: PresenceViewer = {
      id: "profile-riley",
      name: "Riley",
      email: "riley@example.test",
      ...(photo ? { avatarUrl: "/api/users/profile-riley/avatar?v=1" } : {}),
      watchedSessions: [],
    };
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

    const expected = resolveAvatarInitials({
      id: user.id,
      name: user.name,
      username: user.email,
    });
    await waitForSolid(async () => {
      await viewerAvatar.updateComplete;
      const rosterInitials = viewerAvatar.querySelector<HTMLElement>(".viewer-avatar > span");
      const chatInitials = chat.querySelector(".chat-author-avatar__initials");
      expect(rosterInitials?.textContent?.trim()).toBe(expected.initials);
      expect(chatInitials?.textContent?.trim()).toBe(expected.initials);
      const expectedStyle = document.createElement("span").style;
      expectedStyle.background = `hsl(${expected.colorSeed % 360} 48% 42%)`;
      expect(rosterInitials?.style.background).toBe(expectedStyle.background);
      expect(
        viewerAvatar
          .querySelector<HTMLElement>(".viewer-avatar")
          ?.style.getPropertyValue("--viewer-avatar-color"),
      ).toBe(`hsl(${expected.colorSeed % 360} 48% 42%)`);
      expect(chatInitials?.getAttribute("style")).toContain(
        `--chat-author-avatar-hue: ${expected.colorSeed % 360}`,
      );
    });
    const nextUser = {
      ...user,
      id: "profile-jordan",
      name: "Jordan",
      ...(photo ? { avatarUrl: "/api/users/profile-jordan/avatar?v=1" } : {}),
    };
    viewerAvatar.user = nextUser;
    await viewerAvatar.updateComplete;
    const nextColor = `hsl(${resolveAvatarInitials(nextUser).colorSeed % 360} 48% 42%)`;
    expect(nextColor).not.toBe(`hsl(${expected.colorSeed % 360} 48% 42%)`);
    expect(
      viewerAvatar
        .querySelector<HTMLElement>(".viewer-avatar")
        ?.style.getPropertyValue("--viewer-avatar-color"),
    ).toBe(nextColor);
  },
);

it("uses the shared resolver and rejects cross-origin presence avatar metadata", async () => {
  const avatar = mountAvatar({
    id: "profile-mallory",
    name: "Mallory",
    avatarUrl: "https://evil.example/avatar.png",
    watchedSessions: [],
  });

  await waitForSolid(async () => {
    await avatar.updateComplete;
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent?.trim()).toBe("M");
  });
});

it("renders trusted presence avatar routes directly", async () => {
  const avatar = mountAvatar({
    id: "profile-ada",
    name: "Ada Lovelace",
    avatarUrl: "/api/users/profile-ada/avatar",
    watchedSessions: [],
  });

  await waitForSolid(async () => {
    await avatar.updateComplete;
    expect(avatar.querySelector("img")?.getAttribute("src")).toBe("/api/users/profile-ada/avatar");
  });
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
  const fetchAvatar = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      }),
  );
  vi.spyOn(URL, "createObjectURL")
    .mockReturnValueOnce("blob:shared-viewer-avatar")
    .mockReturnValueOnce("blob:updated-viewer-avatar");
  const user = {
    id: "profile-ada",
    identity: { type: "profile", id: "profile-ada" },
    email: "ada@example.test",
    name: "Ada Lovelace",
    avatarUrl: "/api/users/profile-ada/avatar?v=7",
    watchedSessions: [],
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

  await settle(avatars);
  await waitForSolid(() => {
    expect(fetchAvatar).toHaveBeenCalledOnce();
    expect(fetchAvatar).toHaveBeenCalledWith(
      "https://gateway.example.test/api/users/profile-ada/avatar?v=7",
      expect.objectContaining({ headers: { Authorization: "Bearer viewer-token" } }),
    );
  });
  await resolveAvatarImageUrl(user.avatarUrl);
  await settle(avatars);
  expect(avatars.map((avatar) => avatar.querySelector("img")?.getAttribute("src"))).toEqual([
    "blob:shared-viewer-avatar",
    "blob:shared-viewer-avatar",
  ]);
  for (const avatar of avatars) {
    avatar.querySelector("img")?.dispatchEvent(new Event("load"));
    expect(avatar.querySelector(".viewer-avatar")?.classList.contains("is-fallback")).toBe(false);
  }

  fixture.publish({
    ...gateway.snapshot,
    selfUser: { ...user, avatarUrl: "/api/users/profile-ada/avatar?v=8" },
  });
  await settle(avatars);
  await waitForSolid(() =>
    expect(fetchAvatar.mock.calls.map(([url]) => url)).toEqual([
      "https://gateway.example.test/api/users/profile-ada/avatar?v=7",
      "https://gateway.example.test/api/users/profile-ada/avatar?v=8",
    ]),
  );
  await resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=8");
  await settle(avatars);
  expect(avatars.map((avatar) => avatar.querySelector("img")?.getAttribute("src"))).toEqual([
    "blob:shared-viewer-avatar",
    "blob:updated-viewer-avatar",
  ]);

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
  expect(fetchAvatar).toHaveBeenCalledTimes(2);
});

it("renders an empty staticParticipants list without invalidating cached live presence", async () => {
  const payload = { presence: [{ user: { id: "live-viewer" } }] };
  const projection = projectPresencePayload(payload);
  const facepile = mountFacepile({ staticParticipants: [] });
  await facepile.updateComplete;

  expect(facepile.querySelector(".viewer-facepile")).toBeNull();
  expect(projectPresencePayload(payload)).toBe(projection);
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

it("excludes authenticated self when the browser's own presence row lacks a user id", async () => {
  const facepile = mountFacepile({
    selfUser: { id: "self" },
    selfInstanceId: "self-instance",
    sessionKey: "agent:main:active",
    presencePayload: {
      presence: [
        { instanceId: "self-instance", watchedSessions: ["agent:main:active"] },
        {
          instanceId: "self-second-tab",
          user: { id: "self", name: "Self" },
          watchedSessions: ["agent:main:active"],
        },
        {
          user: { id: "alice", name: "Alice" },
          watchedSessions: ["agent:main:active"],
        },
      ],
    },
  });

  await waitForSolid(async () => {
    await facepile.updateComplete;
    expect(facepile.querySelector('[data-viewer-id="self"]')).toBeNull();
    expect(facepile.querySelector('[data-viewer-id="alice"]')).not.toBeNull();
  });
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

it("links faces only when the host opts in, so nested facepiles stay plain", async () => {
  const users: SessionParticipant[] = [
    participant("profile-ada", "Ada King"),
    participant("profile-mira", "Mira"),
  ];
  const mount = async (personActivity?: { basePath: string; navigate: (id: string) => void }) => {
    const facepile = mountFacepile({ staticParticipants: users, personActivity });
    await facepile.updateComplete;
    return facepile;
  };

  const navigate = vi.fn();
  const linked = await mount({ basePath: "", navigate });
  const links = [...linked.querySelectorAll<HTMLAnchorElement>("a.person-activity-avatar-link")];
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/activity/profile-ada",
    "/activity/profile-mira",
  ]);
  const linkedTooltips = [...linked.querySelectorAll("openclaw-tooltip")];
  await settle(linkedTooltips);
  for (const [index, link] of links.entries()) {
    const descriptionId = link.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(descriptionId)?.textContent).toBe(users[index]?.label);
    expect(
      linkedTooltips[index]
        ?.querySelector(".viewer-facepile__tooltip-anchor")
        ?.hasAttribute("aria-describedby"),
    ).toBe(false);
  }

  // Sidebar rows and collapsed group headers render facepiles inside an anchor or button;
  // a nested link there would break the parent's click target.
  const plain = await mount();
  expect(plain.querySelector("a")).toBeNull();
  expect(plain.querySelectorAll("openclaw-viewer-avatar")).toHaveLength(2);
  const plainTooltips = [...plain.querySelectorAll("openclaw-tooltip")];
  await settle(plainTooltips);
  for (const [index, tooltip] of plainTooltips.entries()) {
    const descriptionId =
      tooltip.querySelector(".viewer-facepile__tooltip-anchor")?.getAttribute("aria-describedby") ??
      "";
    expect(document.getElementById(descriptionId)?.textContent).toBe(users[index]?.label);
  }
});

it("reads the profile directory only when teammate avatar metadata is missing", async () => {
  setAvatarGatewayOrigin("https://gateway.example.test", ["viewer-token"]);
  const fetchAvatar = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(new Blob(["avatar"], { type: "image/png" })));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:teammate");
  const fixture = createApplicationGateway();
  const { gateway } = fixture;
  const request = vi.fn(async () => ({
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
  }));
  fixture.publish({
    ...gateway.snapshot,
    phase: "connecting",
    hello: null,
    client: createTestGatewayClient(request),
  });
  // SAFETY: Avatar consumers use only the Gateway capability in this fixture.
  const provider = createSolidApplicationContextProvider({ gateway } as ApplicationContext);
  const user = {
    id: "teammate",
    identity: { type: "profile" as const, id: "teammate" },
    name: "Teammate",
    avatarUrl: "/api/users/teammate/avatar?v=8",
    watchedSessions: [],
  };
  const view = mountSolid(() => createComponent(ViewerAvatar, { user }), {
    wrapper: provider.wrapper,
  });
  const avatar = view.container.querySelector("openclaw-viewer-avatar")!;
  await avatar.updateComplete;
  fixture.publish({
    ...gateway.snapshot,
    phase: "connected",
    hello: gatewayHelloForMethods(["users.list"], ["operator.read"]),
  });
  await avatar.updateComplete;
  await waitForSolid(() =>
    expect(fetchAvatar.mock.calls.at(-1)?.[0]).toBe(
      "https://gateway.example.test/api/users/teammate/avatar?v=8",
    ),
  );
  expect(request).not.toHaveBeenCalled();
  avatar.user = { ...user, avatarUrl: undefined };
  await avatar.updateComplete;
  await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
  await waitForSolid(() =>
    expect(fetchAvatar.mock.calls.at(-1)?.[0]).toBe(
      "https://gateway.example.test/api/users/teammate/avatar?v=7",
    ),
  );
});

it.each([false, true])(
  "retains a participant avatar through metadata updates (linked: %s)",
  async (linked) => {
    const navigate = vi.fn();
    const facepile = mountFacepile({
      personActivity: linked ? { basePath: "", navigate } : undefined,
      staticParticipants: [participant("profile-ada", "Ada")],
    });
    await facepile.updateComplete;
    const avatar = facepile.querySelector("openclaw-viewer-avatar")!;
    const initials = avatar.querySelector(".viewer-avatar__initials")!;
    const link = facepile.querySelector<HTMLAnchorElement>("a");
    link?.focus();
    facepile.staticParticipants = [participant("profile-ada", "Ada King")];
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
