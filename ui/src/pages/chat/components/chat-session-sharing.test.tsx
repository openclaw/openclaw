import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatSessionSharing, type ChatSessionSharingProps } from "./chat-session-sharing.solid.tsx";

function renderSharing(props: Partial<ChatSessionSharingProps>) {
  return {
    session: {
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 1,
      visibility: "shared",
      sharingRole: "owner",
    },
    state: undefined,
    onOpen: vi.fn(),
    onVisibilityChange: vi.fn(),
    onMemberChange: vi.fn(),
    ...props,
  } satisfies ChatSessionSharingProps;
}

function sharingSession(overrides: Partial<NonNullable<ChatSessionSharingProps["session"]>>) {
  return {
    key: "agent:main:main",
    kind: "direct" as const,
    updatedAt: 1,
    visibility: "shared" as const,
    sharingRole: "owner" as const,
    ...overrides,
  };
}

let container: HTMLDivElement | undefined;

afterEach(() => {
  container?.remove();
  container = undefined;
});

const updates = new WeakMap<HTMLElement, (props: ChatSessionSharingProps) => void>();

function render(props: ChatSessionSharingProps, root: HTMLElement) {
  const update = updates.get(root);
  if (update) {
    update(props);
    flush();
    return;
  }
  mountSolid(
    () => {
      const [current, setCurrent] = createSignal(props);
      updates.set(root, setCurrent);
      return <ChatSessionSharing {...current()} />;
    },
    { container: root },
  );
  flush();
}

async function openMenu(root: HTMLElement) {
  const panel = root.querySelector<HTMLElement>(".chat-pane__sharing-panel");
  const trigger = root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger");
  if (panel && trigger && !trigger.disabled && !panel.matches(":popover-open")) {
    trigger.click();
    await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(true));
  }
  return panel;
}

async function select(root: HTMLElement, value: string) {
  await openMenu(root);
  const item = root.querySelector<HTMLButtonElement>(`[data-value="${value}"]`);
  if (!item) {
    throw new Error(`Expected sharing item: ${value}`);
  }
  item.click();
  await Promise.resolve();
  flush();
}

async function mount(props: ChatSessionSharingProps, open = true) {
  container = document.createElement("div");
  document.body.append(container);
  render(props, container);
  if (open) {
    await openMenu(container);
  }
  return container;
}

describe("chat session sharing menu", () => {
  it("reads people only on opening and retains the latest member rows across reopening", async () => {
    const onOpen = vi.fn();
    const sharing = (count: number) =>
      renderSharing({
        onOpen,
        state: {
          loading: false,
          result: {
            sessionKey: "agent:main:main",
            members: [],
            identities: Array.from({ length: count }, (_, index) => ({
              type: "human" as const,
              id: `person-${index}`,
              label: `Person ${index}`,
            })),
            role: "owner",
            allowedVisibilities: ["shared", "read-only"],
          },
        },
      });
    const root = await mount(sharing(100), false);
    expect(root.querySelector(".chat-pane__sharing-trigger")).not.toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    render(sharing(101), root);
    expect(onOpen).not.toHaveBeenCalled();
    const panel = (await openMenu(root))!;
    expect(panel.matches(":popover-open")).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(root.querySelectorAll(".chat-pane__sharing-member")).toHaveLength(101);
    const member = root.querySelector('[data-value="member:person-100"]');
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    await openMenu(root);
    expect(root.querySelector('[data-value="member:person-100"]')).toBe(member);
  });

  it.each(["draft"] as const)(
    "keeps a world-readable %s session visibly public after its menu closes",
    async (visibility) => {
      const session = {
        key: "agent:main:current",
        sessionId: "session-current",
        kind: "direct" as const,
        updatedAt: 1,
        visibility,
        sharingRole: "owner" as const,
      };
      const allowedVisibilities: Array<"draft" | "read-only"> = ["draft", "read-only"];
      const result = {
        sessionKey: session.key,
        members: [],
        identities: [],
        role: "owner" as const,
        allowedVisibilities,
        publicShare: { token: `v1.${"a".repeat(96)}`, createdAt: 1 },
      };
      const renderIndicator = (published: boolean) =>
        renderSharing({
          session,
          state: {
            loading: false,
            result: published ? result : { ...result, publicShare: undefined },
          },
          onPublicShareChange: vi.fn(),
        });
      const root = await mount(renderIndicator(true));

      const panel = root.querySelector<HTMLElement>(".chat-pane__sharing-panel")!;
      panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      flush();
      expect(panel.matches(":popover-open")).toBe(false);
      const indicator = root.querySelector(".chat-pane__public-share-indicator");
      expect(indicator?.textContent?.trim()).toBe("Public");
      expect(indicator?.getAttribute("aria-label")).toContain("anyone can read");

      render(renderIndicator(false), root);
      expect(root.querySelector(".chat-pane__public-share-indicator")).toBeNull();
    },
  );

  it("keeps disabling public access separate from team visibility", async () => {
    const onPublicShareChange = vi.fn();
    const onCopyPublicLink = vi.fn();
    const onVisibilityChange = vi.fn();
    const root = await mount(
      renderSharing({
        session: {
          key: "agent:main:current",
          sessionId: "session-current",
          kind: "direct",
          updatedAt: 1,
          visibility: "draft",
          sharingRole: "owner",
        },
        state: {
          loading: false,
          result: {
            sessionKey: "agent:main:current",
            members: [],
            identities: [],
            role: "owner",
            allowedVisibilities: ["draft", "shared"],
            publicShare: { token: `v1.${"a".repeat(96)}`, createdAt: 1 },
          },
        },
        onVisibilityChange,
        onPublicShareChange,
        onCopyPublicLink,
      }),
    );
    expect(root.textContent).toContain("Public access");
    expect(root.textContent).toContain("anyone can read without signing in");
    await select(root, "public:disable");
    expect(onPublicShareChange).toHaveBeenCalledWith(false);
    expect(onVisibilityChange).not.toHaveBeenCalled();
    await select(root, "public:copy");
    expect(onCopyPublicLink).toHaveBeenCalledOnce();
  });

  it.each(["loading", "read-only", "member"] as const)(
    "refuses public mutations for %s controls",
    async (blocked) => {
      const onPublicShareChange = vi.fn();
      const root = await mount(
        renderSharing({
          session: {
            key: "agent:main:current",
            sessionId: "session-current",
            kind: "direct",
            updatedAt: 1,
            visibility: "shared",
            sharingRole: blocked === "member" ? "member" : "owner",
          },
          state: {
            loading: blocked === "loading",
            result: {
              sessionKey: "agent:main:current",
              members: [],
              identities: [],
              role: "owner",
              allowedVisibilities: ["shared"],
            },
          },
          publicShareDisabledReason: blocked === "read-only" ? "Requires write" : undefined,
          onPublicShareChange,
        }),
      );
      const dropdown = root.querySelector(".chat-pane__sharing-panel");
      if (blocked === "member") {
        expect(dropdown).toBeNull();
      } else {
        expect(root.querySelector('[data-value="public:enable"]')?.hasAttribute("disabled")).toBe(
          true,
        );
        await select(root, "public:enable");
      }
      expect(onPublicShareChange).not.toHaveBeenCalled();
    },
  );

  it("shows the owner picker with policy-gated modes and known identities", async () => {
    const onVisibilityChange = vi.fn();
    const onMemberChange = vi.fn();
    const navigate = vi.fn();
    const root = await mount(
      renderSharing({
        session: sharingSession({ visibility: "read-only" }),
        state: {
          loading: false,
          result: {
            sessionKey: "agent:main:main",
            owner: {
              type: "human",
              id: "owner",
              identity: { type: "profile", id: "owner" },
              label: "Owner",
            },
            members: [],
            identities: [
              { type: "human", id: "owner", label: "Owner" },
              { type: "human", id: "alice", label: "Alice" },
            ],
            role: "owner",
            allowedVisibilities: ["shared", "read-only"],
          },
        },
        ownerViewing: false,
        personActivity: { basePath: "", navigate },
        onOpen: vi.fn(),
        onVisibilityChange,
        onMemberChange,
      }),
    );
    expect(root.querySelector(".chat-pane__sharing-panel")).not.toBeNull();
    expect(root.textContent).toContain("Shared");
    expect(root.textContent).toContain("Read-only");
    expect(root.textContent).not.toContain("Suggest");
    expect(root.textContent).toContain("Alice");
    expect(root.querySelector('button[data-value="member:owner"]')).toBeNull();
    expect(root.querySelector(".chat-pane__sharing-owner-title")?.textContent?.trim()).toBe(
      "Owner",
    );
    expect(
      root.querySelector(".chat-pane__sharing-owner .session-menu__text")?.textContent?.trim(),
    ).toBe("Owner");
    expect(
      root.querySelector(".chat-pane__sharing-owner openclaw-session-owner-chip"),
    ).not.toBeNull();
    const ownerLink = root.querySelector<HTMLAnchorElement>(
      ".chat-pane__sharing-owner a.person-activity-link",
    );
    expect(ownerLink?.getAttribute("href")).toBe("/activity/owner");
    const ownerAvatarLink = root.querySelector<HTMLAnchorElement>(
      ".chat-pane__sharing-owner a.person-activity-avatar-link",
    );
    expect(ownerAvatarLink?.tabIndex).toBe(-1);
    expect(ownerAvatarLink?.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector(".session-menu__separator")).toBeNull();

    ownerLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledWith("owner", "Owner");

    await select(root, "visibility:shared");
    await select(root, "member:alice");
    expect(onVisibilityChange).toHaveBeenCalledWith("shared");
    expect(onMemberChange).toHaveBeenCalledWith("alice", true);
  });

  it("renders member presentation from identity.type, not from ID spelling", async () => {
    const root = await mount(
      renderSharing({
        session: sharingSession({}),
        state: {
          loading: false,
          result: {
            sessionKey: "agent:main:main",
            members: [],
            identities: [
              { type: "human", id: "profile-vyctor", label: "Vyctor Brzezowski" },
              // Human identity IDs are opaque (e.g. an inbound SenderId) and
              // can contain "channel:" as a substring; the recorded type,
              // not the ID string, must drive presentation.
              { type: "human", id: "channel:chn_design", label: "Design" },
              { type: "agent", id: "discord:channel:operations", label: "Operations" },
              { type: "system", id: "channel:audit", label: "Audit" },
            ],
            role: "owner",
            allowedVisibilities: ["shared"],
          },
        },
        onOpen: vi.fn(),
        onVisibilityChange: vi.fn(),
        onMemberChange: vi.fn(),
      }),
    );

    const humans = [
      root.querySelector('button[data-value="member:profile-vyctor"]'),
      root.querySelector('button[data-value="member:channel:chn_design"]'),
    ];
    const nonHumans = [
      root.querySelector('button[data-value="member:discord:channel:operations"]'),
      root.querySelector('button[data-value="member:channel:audit"]'),
    ];

    for (const human of humans) {
      expect(human?.querySelector("openclaw-session-owner-chip")).not.toBeNull();
    }
    for (const nonHuman of nonHumans) {
      expect(nonHuman?.querySelector("openclaw-session-owner-chip")).toBeNull();
      expect(nonHuman?.querySelector(".chat-pane__sharing-member-icon svg")).not.toBeNull();
    }
  });

  it("keeps the linked owner beside the draft marker for a non-manager", async () => {
    const root = await mount(
      renderSharing({
        session: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 1,
          visibility: "draft",
          sharingRole: "member",
          owner: {
            actor: {
              type: "human",
              id: "owner",
              identity: { type: "profile", id: "owner" },
              label: "Owner",
            },
          },
        },
        state: undefined,
        ownerViewing: false,
        personActivity: { basePath: "", navigate: vi.fn() },
        showOwner: true,
        onOpen: vi.fn(),
        onVisibilityChange: vi.fn(),
        onMemberChange: vi.fn(),
      }),
    );
    expect(root.querySelector(".chat-pane__sharing-panel")).toBeNull();
    const indicator = root.querySelector(".chat-pane__draft-indicator");
    expect(indicator?.querySelector("svg")).not.toBeNull();
    expect(indicator?.textContent?.trim()).toBe("");
    const ownerLink = root.querySelector<HTMLAnchorElement>(
      "a.person-activity-avatar-link:has(openclaw-session-owner-chip)",
    );
    expect(ownerLink?.getAttribute("href")).toBe("/activity/owner");
    expect(ownerLink?.tabIndex).toBe(0);
    expect(ownerLink?.hasAttribute("aria-hidden")).toBe(false);
    ownerLink?.focus();
    expect(document.activeElement).toBe(ownerLink);
  });

  it("keeps read-only owner controls visible but refuses disabled selections", async () => {
    const onOpen = vi.fn();
    const onVisibilityChange = vi.fn();
    const onMemberChange = vi.fn();
    const root = await mount(
      renderSharing({
        session: sharingSession({}),
        state: {
          loading: false,
          result: {
            sessionKey: "agent:main:main",
            members: [{ identityId: "alice", addedBy: "owner", addedAt: 1 }],
            identities: [
              {
                type: "human",
                id: "alice",
                label: "Alice with a very long selected member display name",
              },
              {
                type: "human",
                id: "bob",
                label: "Bob with a very long available member display name",
              },
            ],
            role: "owner",
            allowedVisibilities: ["shared", "read-only"],
          },
        },
        visibilityDisabledReason: "Requires write",
        memberAddDisabledReason: "Requires write",
        memberRemoveDisabledReason: "Requires write",
        onOpen,
        onVisibilityChange,
        onMemberChange,
      }),
    );
    expect(root.querySelector(".chat-pane__sharing-panel")).not.toBeNull();
    expect(
      root.querySelector<HTMLElement>('button[data-value="visibility:read-only"]')?.title,
    ).toBe("Requires write");
    expect(root.querySelector('button[data-value="member:alice"]')?.hasAttribute("disabled")).toBe(
      true,
    );
    expect(root.querySelector('button[data-value="member:bob"]')?.hasAttribute("disabled")).toBe(
      true,
    );
    for (const identityId of ["alice", "bob"]) {
      const item = root.querySelector<HTMLElement>(`button[data-value="member:${identityId}"]`);
      expect(item?.title).toBe("Requires write");
      expect(item?.querySelector(".chat-pane__sharing-member-label")?.hasAttribute("title")).toBe(
        false,
      );
    }

    await select(root, "visibility:read-only");
    await select(root, "member:alice");
    await select(root, "member:bob");

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onVisibilityChange).not.toHaveBeenCalled();
    expect(onMemberChange).not.toHaveBeenCalled();
  });

  it("disables opening when sharing reads are unavailable", async () => {
    const onOpen = vi.fn();
    const root = await mount(
      renderSharing({
        session: sharingSession({}),
        state: undefined,
        openDisabledReason: "Connect to the Gateway",
        onOpen,
        onVisibilityChange: vi.fn(),
        onMemberChange: vi.fn(),
      }),
    );

    expect(root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.disabled).toBe(
      true,
    );
    root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.click();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps visibility controls usable without member-list support", async () => {
    const onOpen = vi.fn();
    const onVisibilityChange = vi.fn();
    const root = await mount(
      renderSharing({
        session: sharingSession({}),
        state: undefined,
        allowedVisibilities: ["shared", "read-only"],
        membersAvailable: false,
        onOpen,
        onVisibilityChange,
        onMemberChange: vi.fn(),
      }),
    );

    expect(root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.disabled).toBe(
      false,
    );
    expect(root.querySelector('button[data-value="visibility:read-only"]')).not.toBeNull();
    expect(root.textContent).not.toContain("People");

    await select(root, "visibility:read-only");

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onVisibilityChange).toHaveBeenCalledWith("read-only");
  });

  it.each([{ name: "visibility-only", membersAvailable: false }])(
    "shows rejected sharing changes for $name Gateways",
    async ({ membersAvailable }) => {
      const root = await mount(
        renderSharing({
          session: sharingSession({}),
          state: { loading: false, error: "Visibility update rejected" },
          allowedVisibilities: ["shared", "read-only"],
          membersAvailable,
          onOpen: vi.fn(),
          onVisibilityChange: vi.fn(),
          onMemberChange: vi.fn(),
        }),
      );

      const error = root.querySelector(".chat-pane__sharing-status--error");
      expect(error?.textContent).toContain("Visibility update rejected");
      expect(error?.getAttribute("role")).toBe("alert");
      expect(root.querySelectorAll(".chat-pane__sharing-title")).toHaveLength(
        membersAvailable ? 2 : 1,
      );
    },
  );
});
