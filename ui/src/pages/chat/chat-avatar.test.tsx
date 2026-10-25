/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { currentThemeBranding, setCurrentThemeBranding } from "../../app/theme-branding.ts";
import { resolveAvatarHat } from "../../components/agent-avatar-hat.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { ChatAvatar, ForwardedAvatar, type ChatAvatarProps } from "./chat-avatar-view.tsx";
import {
  invalidateChatAvatarCache,
  refreshChatAvatar,
  refreshSenderAgentAvatars,
} from "./chat-avatar.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAvatarUrl } from "./chat-state-route.ts";
import { ChatAuthorAvatar } from "./components/chat-author-avatar.ts";
import { ChatWelcome } from "./components/chat-welcome.tsx";

function imageResponse() {
  return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
}

function mockAvatarFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageResponse());
}

function mockBlobUrls(...urls: string[]) {
  const create = vi.spyOn(URL, "createObjectURL");
  for (const url of urls) {
    create.mockReturnValueOnce(url);
  }
}

function pendingAvatar(url: string) {
  const response = createDeferred<Response>();
  const fetchAvatar = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
  vi.spyOn(URL, "createObjectURL").mockReturnValue(url);
  return { response, fetchAvatar };
}

function agentIdentity(agentId: string, revision = 1, name = agentId) {
  return { agentId, name, avatar: `/avatar/${agentId}?v=${revision}` };
}

function avatarHost(sessionKey = "agent:main:first", withStatus = true) {
  setAvatarGatewayOrigin("https://gateway.example.test", ["test-token"]);
  return makeChatHost({
    sessionKey,
    requestHandlers: {
      "agent.identity.get": ({ agentId }: { agentId: string }) =>
        withStatus ? { ...agentIdentity(agentId), avatarStatus: "local" } : agentIdentity(agentId),
    },
  });
}

function waitForImage(container: Element, src: string, selector = "img") {
  return vi.waitFor(() => {
    const image = container.querySelector<HTMLImageElement>(selector);
    expect(image?.getAttribute("src")).toBe(src);
    return image!;
  });
}

function expectBearerFetch(
  fetchAvatar: ReturnType<typeof mockAvatarFetch>,
  url: unknown,
  token: string,
) {
  expect(fetchAvatar).toHaveBeenLastCalledWith(
    url,
    expect.objectContaining({ headers: { Authorization: `Bearer ${token}` } }),
  );
}

function nativeSender(accountId = "sample-bot") {
  return {
    name: "Riley Adams",
    identity: {
      type: "observation" as const,
      pluginId: "telegram",
      accountId,
      id: "1000000001",
      senderKind: "human" as const,
    },
  };
}

function channelPortrait(
  basePath = "",
  revision = "portrait-1",
): NonNullable<ChatAvatarProps["channelAvatar"]> {
  return {
    key: "agent:main:main",
    channelAvatarUrl: `${basePath}/__openclaw__/channel-avatar/agent%3Amain%3Amain?v=${revision}`,
    origin: {
      provider: "telegram",
      accountId: "sample-bot",
      chatType: "direct",
      from: "telegram:1000000001",
    },
  };
}

function identityCapability(host: ReturnType<typeof makeChatHost>) {
  return createAgentIdentityCapability({
    snapshot: { client: host.client, phase: "connected" },
    subscribe: () => () => undefined,
  });
}

function renderAvatar(
  params: [
    role: string,
    assistant?: ChatAvatarProps["assistant"],
    user?: ChatAvatarProps["user"],
    sender?: ChatAvatarProps["sender"],
    channelAvatar?: ChatAvatarProps["channelAvatar"],
  ],
) {
  const [role, assistant, user, sender, channelAvatar] = params;
  const props = { role, assistant, user, sender, channelAvatar };
  const view = mountSolid(() => <ChatAvatar {...props} />);
  return view.container.querySelector<HTMLElement>(".chat-avatar");
}

it("refreshes a mounted channel portrait when Gateway credentials change", async () => {
  setAvatarGatewayOrigin(window.location.origin, ["old-avatar-token"]);
  const fetchAvatar = mockAvatarFetch();
  mockBlobUrls("blob:old-portrait", "blob:new-portrait");
  const view = mountSolid(() => (
    <ChatAuthorAvatar
      sender={nativeSender()}
      channelAvatar={channelPortrait("", "credential-change")}
    />
  ));
  await waitForImage(view.container, "blob:old-portrait");
  setAvatarGatewayOrigin(window.location.origin, ["new-avatar-token"]);
  await waitForImage(view.container, "blob:new-portrait");
  expectBearerFetch(fetchAvatar, expect.any(String), "new-avatar-token");
});

it("resolves a mounted agent-author portrait against the replacement Gateway", async () => {
  setAvatarGatewayOrigin("https://gateway.example.test", ["old-avatar-token"]);
  const fetchAvatar = mockAvatarFetch();
  mockBlobUrls("blob:old-agent-author", "blob:new-agent-author");
  const view = mountSolid(() => (
    <ChatAuthorAvatar
      sender={{
        name: "Ada",
        identity: { type: "agent", id: "ada" },
        profileAvatarUrl: "/avatar/ada",
      }}
    />
  ));
  const image = await waitForImage(view.container, "blob:old-agent-author");
  setAvatarGatewayOrigin("https://replacement.example.test", ["new-avatar-token"]);
  expect(await waitForImage(view.container, "blob:new-agent-author")).toBe(image);
  expectBearerFetch(fetchAvatar, "https://replacement.example.test/avatar/ada", "new-avatar-token");
});

it.each(["assistant", "local", "profile"] as const)(
  "refreshes a mounted %s chat image when Gateway credentials change",
  async (kind) => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["old-avatar-token"]);
    const fetchAvatar = mockAvatarFetch();
    mockBlobUrls("blob:old-chat-image", "blob:new-chat-image");
    const url = kind === "profile" ? "/api/users/ada/avatar" : "/avatar/ada";
    const view = mountSolid(() => (
      <ChatAvatar
        role={kind === "assistant" ? "assistant" : "user"}
        assistant={
          kind === "assistant"
            ? { agentId: "ada", name: "Ada", avatar: url, textAvatar: "A" }
            : undefined
        }
        user={kind === "local" ? { name: "Ada", avatar: url } : undefined}
        sender={kind === "profile" ? { id: "ada", name: "Ada", profileAvatarUrl: url } : undefined}
      />
    ));
    const image = await waitForImage(view.container, "blob:old-chat-image");
    setAvatarGatewayOrigin("https://gateway.example.test", ["new-avatar-token"]);
    expect(await waitForImage(view.container, "blob:new-chat-image")).toBe(image);
    expectBearerFetch(fetchAvatar, `https://gateway.example.test${url}`, "new-avatar-token");
  },
);

it("binds footer portraits to the account and sender under a base path", () => {
  const basePath = "/console";
  setAvatarGatewayOrigin(window.location.origin, [], basePath);
  const sender = nativeSender();
  const identity = { ...sender.identity };
  const { container } = mountSolid(() => (
    <ChatAuthorAvatar
      sender={sender}
      class="chat-author-avatar"
      channelAvatar={channelPortrait(basePath)}
    />
  ));
  expect(Boolean(container.querySelector("openclaw-channel-avatar"))).toBe(true);
  expect(container.querySelector("[role=img]")?.getAttribute("aria-label")).toBe("Riley Adams");
  expect(sender.identity).toEqual(identity);
});

it("renders a source-bound native portrait without borrowing the viewer's profile", () => {
  const sender = nativeSender();
  const identity = { ...sender.identity };
  const avatar = renderAvatar([
    "user",
    undefined,
    { name: "Viewer", avatar: "/api/users/gateway-owner/avatar" },
    sender,
    channelPortrait(),
  ]);
  const image = avatar?.querySelector<HTMLElement & { routeUrl: string }>(
    "openclaw-channel-avatar",
  );
  expect(image?.routeUrl).toContain("provider=telegram&account=sample-bot&sender=1000000001");
  expect(avatar?.getAttribute("aria-label")).toBe("Riley Adams");
  expect(sender.identity).toEqual(identity);
});

it("keeps sender initials when a channel portrait belongs to another account", () => {
  const avatar = renderAvatar([
    "user",
    undefined,
    { name: "Viewer", avatar: "/api/users/gateway-owner/avatar" },
    nativeSender("another-bot"),
    channelPortrait(),
  ]);
  expect(avatar?.querySelector("openclaw-channel-avatar")).toBeNull();
  expect(avatar?.querySelector("img")).toBeNull();
  expect(avatar?.textContent?.trim()).toBe("RA");
});

afterEach(() => {
  cleanupSolid();
  setAvatarGatewayOrigin(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveChatAvatarUrl", () => {
  it("prefers the authenticated avatar blob over persisted and protected URLs", () => {
    const state = {
      sessionKey: "agent:main:main",
      chatAvatarUrl: "blob:authenticated-avatar",
      assistantAvatar: "/avatar/main",
      assistantAgentId: "main",
    } as unknown as ChatPageHost;

    expect(resolveChatAvatarUrl(state)).toBe("blob:authenticated-avatar");
  });
});

describe("ChatAvatar", () => {
  it("updates an image avatar's hat when the theme changes", () => {
    const previous = currentThemeBranding();
    const adorned = { ...previous, avatarHat: "party" as const };
    const agentId = Array.from({ length: 100 }, (_, index) => `hat-agent-${index}`).find((id) =>
      resolveAvatarHat(id, adorned),
    )!;
    setCurrentThemeBranding(resolveThemeBranding(undefined));
    const view = mountSolid(() => (
      <ChatAvatar
        role="assistant"
        assistant={{ agentId, name: "Assistant", avatar: "blob:portrait" }}
      />
    ));
    try {
      expect(view.container.querySelector(".chat-avatar-slot > .identity-avatar__hat")).toBeNull();
      setCurrentThemeBranding(adorned);
      flush();
      expect(
        view.container.querySelector(".chat-avatar-slot > .identity-avatar__hat--party"),
      ).not.toBeNull();
    } finally {
      setCurrentThemeBranding(previous);
      view.unmount();
    }
  });
  it("shares one agent face across welcome, transcript, forwarded messages, and typed author markers", async () => {
    const sender = {
      id: "display-id",
      name: "Scout",
      identity: { type: "agent", id: "scout" },
    } as const;
    const { container } = mountSolid(() => (
      <>
        <ChatWelcome
          currentAgentId="scout"
          assistantName="Scout"
          assistantAvatar={null}
          onDraftChange={() => undefined}
          onSend={() => undefined}
        />
        <ChatAvatar
          role="assistant"
          assistant={{ agentId: "scout", name: "Scout", avatar: null }}
        />
        <ChatAvatar
          role="assistant"
          assistant={{
            agentId: "scout",
            name: "Renamed Scout",
            avatar: "https://example.com/avatar.png",
          }}
        />
        <ForwardedAvatar agentId="scout" options={{ agentId: "main", agents: [{ id: "scout" }] }} />
        <ChatAuthorAvatar sender={sender} />
        <ChatAvatar role="user" sender={sender} />
      </>
    ));
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".identity-avatar__agent-face")).toHaveLength(6),
    );
    const faces = [...container.querySelectorAll(".identity-avatar__agent-face")].map(
      (face) => face.outerHTML,
    );
    expect(new Set(faces).size).toBe(1);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".chat-author-avatar__initials")).toBeNull();
  });

  it.each(["openclaw"])("keeps the product mark for system agent %s", (agentId) => {
    const image = renderAvatar([
      "assistant",
      { agentId, name: "System", avatar: "blob:configured-image", textAvatar: "🦉" },
    ]);
    expect(image?.matches("img.chat-avatar.assistant")).toBe(true);
    expect(image?.getAttribute("src")).toBe("/favicon.svg");
    expect(image?.getAttribute("alt")).toBe("System");
  });

  it("shares authenticated welcome and transcript avatars without an explicit token", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["device-token"]);
    const { response, fetchAvatar } = pendingAvatar("blob:shared-agent");
    const avatar = "/avatar/main?v=1";
    const mountWelcome = () =>
      mountSolid(() => (
        <>
          <ChatWelcome
            assistantName="Main"
            assistantAvatar={avatar}
            onDraftChange={() => undefined}
            onSend={() => undefined}
          />
          <ChatWelcome
            assistantName="Main"
            assistantAvatar={null}
            assistantAvatarUrl={avatar}
            onDraftChange={() => undefined}
            onSend={() => undefined}
          />
        </>
      ));
    let welcome = mountWelcome();
    const transcript = mountSolid(() => (
      <ChatAvatar role="assistant" assistant={{ avatar, name: "Main" }} />
    ));
    const sources = () =>
      [
        ...welcome.container.querySelectorAll("img"),
        ...transcript.container.querySelectorAll("img"),
      ].map((image) => image.getAttribute("src"));
    expect(sources()).toEqual([null, null, null]);
    await vi.waitFor(() => expect(fetchAvatar).toHaveBeenCalledOnce());
    expect(fetchAvatar).toHaveBeenCalledWith(
      `https://gateway.example.test${avatar}`,
      expect.objectContaining({ headers: { Authorization: "Bearer device-token" } }),
    );
    response.resolve(imageResponse());
    await vi.waitFor(() => expect(sources()).toEqual(Array(3).fill("blob:shared-agent")));
    welcome.unmount();
    welcome = mountWelcome();
    await vi.waitFor(() => expect(sources()).toEqual(Array(3).fill("blob:shared-agent")));
    expect(fetchAvatar).toHaveBeenCalledOnce();
  });

  it("renders local user text avatars", () => {
    const textAvatar = renderAvatar(["user", undefined, { name: "Buns", avatar: "AB" }]);
    expect(textAvatar?.tagName).toBe("DIV");
    expect(textAvatar?.textContent?.trim()).toBe("AB");
  });

  it("swaps a failing local user image to initials instead of a broken image", () => {
    const [user, setUser] = createSignal({ name: "Buns", avatar: "/avatar/user" });
    const { container } = mountSolid(() => <ChatAvatar role="user" user={user()} />);
    const slot = container.querySelector<HTMLElement>(".chat-avatar-slot");
    const image = slot?.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/avatar/user");
    expect(image?.getAttribute("alt")).toBe("Buns");
    expect(slot?.classList.contains("is-fallback")).toBe(false);

    image?.dispatchEvent(new Event("error"));
    flush();
    expect(slot?.classList.contains("is-fallback")).toBe(true);
    expect(slot?.querySelector(".chat-avatar--sender-initials")?.textContent?.trim()).toBe("B");

    setUser({ ...user() });
    flush();
    expect(container.querySelector(".chat-avatar-slot")).toBe(slot);
    expect(slot?.classList.contains("is-fallback")).toBe(true);
    expect(slot?.querySelector(".chat-avatar--sender-initials")?.textContent?.trim()).toBe("B");
  });
});

describe("refreshChatAvatar", () => {
  it("replaces a revised avatar without revoking a retained sibling's image", async () => {
    const host = avatarHost();
    const identities = identityCapability(host);
    const sibling = makeChatHost({ client: host.client });
    const fetchAvatar = mockAvatarFetch();
    mockBlobUrls("blob:old", "blob:new");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    await Promise.all([refreshChatAvatar(host), refreshChatAvatar(sibling)]);
    expect(fetchAvatar).toHaveBeenCalledOnce();
    identities.invalidate(["main"]);
    host.request.mockResolvedValue(agentIdentity("main", 2, "Main"));
    const refresh = refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBe("blob:old");
    await refresh;
    expect(host.chatAvatarUrl).toBe("blob:new");
    expect(sibling.chatAvatarUrl).toBe("blob:old");
    expect(revoke).not.toHaveBeenCalled();
    invalidateChatAvatarCache(host);
    expect(sibling.chatAvatarUrl).toBe("blob:old");
    expect(revoke).not.toHaveBeenCalled();
    invalidateChatAvatarCache(sibling);
  });

  it("keeps only same-context working avatars on a credentials replacement", async () => {
    const host = avatarHost();
    const identities = identityCapability(host);
    const sibling = makeChatHost({ client: host.client });
    const fetchAvatar = mockAvatarFetch();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:working-avatar");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    await Promise.all([refreshChatAvatar(host), refreshChatAvatar(sibling)]);
    const replacement = agentIdentity("main", 2, "Main");
    identities.invalidate(["main"]);
    host.request.mockResolvedValue(replacement);
    host.connected = false;
    sibling.connected = false;
    await Promise.all([refreshChatAvatar(host), refreshChatAvatar(sibling)]);
    setAvatarGatewayOrigin("https://gateway.example.test", ["replacement-token"]);
    host.client = makeChatHost({
      requestHandlers: { "agent.identity.get": replacement },
    }).client;
    host.connectionEpoch += 1;
    host.connected = true;
    fetchAvatar.mockResolvedValue(new Response(null, { status: 503 }));
    await refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBeNull();
    expect(sibling.chatAvatarUrl).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:working-avatar");
    expectBearerFetch(
      fetchAvatar,
      expect.stringContaining("/avatar/main?v=2"),
      "replacement-token",
    );
    invalidateChatAvatarCache(host);
    invalidateChatAvatarCache(sibling);
  });

  it("keeps a working avatar across repeated failed replacements until the identity clears it", async () => {
    const host = avatarHost();
    const identities = identityCapability(host);
    const fetchAvatar = mockAvatarFetch();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:working-avatar");
    await refreshChatAvatar(host);
    identities.invalidate(["main"]);
    host.request.mockResolvedValue(agentIdentity("main", 2, "Main"));
    fetchAvatar.mockResolvedValue(new Response(null, { status: 503 }));
    await refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBe("blob:working-avatar");
    await refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBe("blob:working-avatar");
    expect(fetchAvatar).toHaveBeenCalledTimes(2);
    identities.invalidate(["main"]);
    host.request.mockResolvedValue({ agentId: "main", name: "Main", avatar: "🦉" });
    await refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBeNull();
    invalidateChatAvatarCache(host);
  });

  it.each(["session", "connection", "invalidation"])(
    "rejects a pending avatar after %s changes",
    async (change) => {
      const host = avatarHost();
      const { response, fetchAvatar } = pendingAvatar("blob:stale");
      const pending = refreshChatAvatar(host);
      await vi.waitFor(() => expect(fetchAvatar).toHaveBeenCalledOnce());
      if (change === "session") {
        host.sessionKey = "agent:other:main";
      }
      if (change === "connection") {
        host.connectionEpoch += 1;
      }
      if (change === "invalidation") {
        invalidateChatAvatarCache(host);
      }
      response.resolve(imageResponse());
      await pending;
      expect(host.chatAvatarUrl).toBeNull();
    },
  );

  it("keeps missing avatar diagnostics without fetching a remote source", async () => {
    const host = avatarHost();
    host.request.mockResolvedValue({
      agentId: "main",
      name: "Main",
      avatar: "https://example.com/avatar.png",
      avatarSource: "https://example.com/avatar.png",
      avatarStatus: "none",
      avatarReason: "missing",
    });
    const fetchAvatar = vi.spyOn(globalThis, "fetch");
    await refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBeNull();
    expect(host.chatAvatarReason).toBe("missing");
    expect(fetchAvatar).not.toHaveBeenCalled();
  });
});

describe("refreshSenderAgentAvatars", () => {
  function forwardedMessages(...agentIds: string[]) {
    return agentIds.map((agentId) => ({
      role: "assistant",
      content: "report",
      senderSession: { agentId },
    }));
  }
  function senderHost() {
    return {
      ...avatarHost("agent:main:main", false),
      agentsList: { defaultId: "main", agents: [{ id: "main" }, { id: "research" }] },
      senderAgentAvatars: undefined as ReadonlyMap<string, string | null> | undefined,
    };
  }

  it("keeps forwarded identity visible through pending and HTTP 404", async () => {
    const host = senderHost();
    const { response, fetchAvatar } = pendingAvatar("blob:forwarded-avatar");
    host.chatMessages = forwardedMessages("research");
    const pending = refreshSenderAgentAvatars(host);
    await vi.waitFor(() => expect(fetchAvatar).toHaveBeenCalledOnce());
    const [avatars, setAvatars] = createSignal(host.senderAgentAvatars);
    const { container } = mountSolid(() => (
      <ForwardedAvatar
        agentId="research"
        options={{
          agentId: "main",
          agents: host.agentsList.agents,
          senderAgentAvatars: avatars(),
        }}
      />
    ));
    expect(container.querySelector("img")).toBeNull();
    await vi.waitFor(() =>
      expect(container.querySelector(".identity-avatar__agent-face")).not.toBeNull(),
    );
    const face = container.querySelector(".identity-avatar__agent-face")?.outerHTML;
    expect(fetchAvatar).toHaveBeenCalledWith(
      "https://gateway.example.test/avatar/research?v=1",
      expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
    );
    response.resolve(new Response(null, { status: 404 }));
    await pending;
    setAvatars(host.senderAgentAvatars);
    flush();
    expect(container.querySelector("img")).toBeNull();
    await vi.waitFor(() =>
      expect(container.querySelector(".identity-avatar__agent-face")?.outerHTML).toBe(face),
    );
    invalidateChatAvatarCache(host);
  });

  it("shares sender snapshots with the current-agent cache and skips unknown agents", async () => {
    const host = senderHost();
    const fetchAvatar = mockAvatarFetch();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:research-avatar");
    host.chatMessages = forwardedMessages("main", "unknown", "research", "research");
    await Promise.all([refreshSenderAgentAvatars(host), refreshSenderAgentAvatars(host)]);
    expect(host.senderAgentAvatars).toEqual(new Map([["research", "blob:research-avatar"]]));
    expect(fetchAvatar).toHaveBeenCalledWith(
      "https://gateway.example.test/avatar/research?v=1",
      expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
    );
    host.sessionKey = "agent:research:main";
    await refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBe("blob:research-avatar");
    expect(fetchAvatar).toHaveBeenCalledOnce();
    invalidateChatAvatarCache(host);
  });

  it("preserves forwarded-avatar ownership on a failed replacement", async () => {
    const host = senderHost();
    const identities = identityCapability(host);
    const fetchAvatar = mockAvatarFetch();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:working-forward");
    host.chatMessages = forwardedMessages("research");
    await refreshSenderAgentAvatars(host);
    identities.invalidate(["research"]);
    host.request.mockResolvedValue(agentIdentity("research", 2, "Research"));
    fetchAvatar.mockResolvedValue(new Response(null, { status: 503 }));
    host.chatMessages = forwardedMessages("research");
    await refreshSenderAgentAvatars(host);
    expect(host.senderAgentAvatars?.get("research")).toBe("blob:working-forward");
    host.chatMessages = forwardedMessages("research");
    await refreshSenderAgentAvatars(host);
    expect(host.senderAgentAvatars?.get("research")).toBe("blob:working-forward");
    expect(fetchAvatar).toHaveBeenCalledTimes(2);
    host.connected = false;
    await refreshSenderAgentAvatars(host);
    expect(host.senderAgentAvatars?.size).toBe(0);
    invalidateChatAvatarCache(host);
  });

  it("loads newly committed forwards and releases cleared senders", async () => {
    const host = senderHost();
    const fetchAvatar = mockAvatarFetch();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:forwarded");
    await refreshSenderAgentAvatars(host);
    expect(fetchAvatar).not.toHaveBeenCalled();
    host.chatMessages = forwardedMessages("research");
    await refreshSenderAgentAvatars(host);
    await refreshSenderAgentAvatars(host);
    expect(host.senderAgentAvatars?.get("research")).toBe("blob:forwarded");
    expect(fetchAvatar).toHaveBeenCalledOnce();
    host.chatMessages = [];
    await refreshSenderAgentAvatars(host);
    expect(host.senderAgentAvatars?.size).toBe(0);
    invalidateChatAvatarCache(host);
  });

  it("retires a forwarded batch across invalidation without releasing its replacement", async () => {
    const host = senderHost();
    const identities = identityCapability(host);
    const oldResponse = createDeferred<Response>();
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => oldResponse.promise)
      .mockResolvedValueOnce(imageResponse())
      .mockImplementation(async () => new Response(null, { status: 404 }));
    mockBlobUrls("blob:new-forward", "blob:old-forward");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    host.chatMessages = forwardedMessages("research");
    const older = refreshSenderAgentAvatars(host);
    await vi.waitFor(() => expect(fetchAvatar).toHaveBeenCalledOnce());

    identities.invalidate(["research"]);
    invalidateChatAvatarCache(host);
    host.request.mockResolvedValue({ agentId: "research", avatar: "/avatar/research?v=2" });
    await refreshSenderAgentAvatars(host);
    expect(host.senderAgentAvatars?.get("research")).toBe("blob:new-forward");
    oldResponse.resolve(imageResponse());
    await older;
    expect(host.senderAgentAvatars?.get("research")).toBe("blob:new-forward");

    expect(revoke).not.toHaveBeenCalledWith("blob:new-forward");
    invalidateChatAvatarCache(host);
  });

  it.each(["session", "request", "connection", "roster"])(
    "does not publish a sender avatar after its %s changes",
    async (change) => {
      const host = senderHost();
      const { response, fetchAvatar } = pendingAvatar("blob:stale");
      host.chatMessages = forwardedMessages("research");
      const pending = refreshSenderAgentAvatars(host);
      await vi.waitFor(() => expect(fetchAvatar).toHaveBeenCalledOnce());
      if (change === "session") {
        host.sessionKey = "agent:main:other";
      }
      if (change === "request") {
        host.chatMessages = [];
        await refreshSenderAgentAvatars(host);
      }
      if (change === "connection") {
        host.connectionEpoch += 1;
      }
      if (change === "roster") {
        host.agentsList = { defaultId: "main", agents: [{ id: "main" }] };
      }
      response.resolve(imageResponse());
      await pending;
      expect(host.senderAgentAvatars?.size ?? 0).toBe(0);
    },
  );

  it("bounds first-seen eligible sender loads without revoking the current agent's blob", async () => {
    const host = senderHost();
    const agents = Array.from({ length: 30 }, (_, i) => ({ id: `sender-${i}` }));
    host.agentsList.agents.push(...agents);
    const fetchAvatar = mockAvatarFetch();
    let sequence = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:avatar-${sequence++}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    await refreshChatAvatar(host);
    const current = host.chatAvatarUrl;
    expect(current).toBe("blob:avatar-0");
    const agentIds = agents.map((agent) => agent.id).toReversed();
    const expectedIds = agentIds.slice(0, 23);
    host.chatMessages = [
      null,
      ...forwardedMessages("main", "unknown"),
      { role: "user", senderSession: { agentId: "sender-0" } },
      { role: "Assistant", senderSession: { agentId: "sender-1" } },
      { role: "assistant", toolName: "read", senderSession: { agentId: "sender-2" } },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "read" }],
        senderSession: { agentId: "sender-3" },
      },
      { role: "assistant", senderSession: { sessionKey: "agent:sender-4:source" } },
      { role: "assistant", senderSession: { agentId: 42 } },
      { role: "assistant", senderSession: { agentId: " " } },
      ...agentIds.flatMap((id) => forwardedMessages(` ${id} `, ` ${id} `, "main", "unknown")),
    ];
    await refreshSenderAgentAvatars(host);
    expect([...(host.senderAgentAvatars?.keys() ?? [])]).toEqual(expectedIds);
    expect(host.request.mock.calls).toEqual([
      ["agent.identity.get", { agentId: "main" }],
      ...expectedIds.map((agentId) => ["agent.identity.get", { agentId }]),
    ]);
    expect(
      [...host.senderAgentAvatars!.values()].every((url) => url?.startsWith("blob:avatar-")),
    ).toBe(true);
    expect(fetchAvatar).toHaveBeenCalledTimes(24);
    expect(host.chatAvatarUrl).toBe(current);
    expect(revoke).not.toHaveBeenCalled();
    invalidateChatAvatarCache(host);
  });
});
