import { createSignal, flush } from "solid-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatSessionSharing, type ChatSessionSharingProps } from "./chat-session-sharing.solid.tsx";

function renderSharing(props: Partial<ChatSessionSharingProps>) {
  return {
    session: sharingSession({}),
    state: undefined,
    onOpen: vi.fn(),
    onVisibilityChange: vi.fn(),
    onMemberChange: vi.fn(),
    ...props,
  } satisfies ChatSessionSharingProps;
}

type SharingResult = NonNullable<NonNullable<ChatSessionSharingProps["state"]>["result"]>;
function sharingState(result: Partial<SharingResult> = {}, loading = false) {
  return {
    loading,
    result: {
      sessionKey: "agent:main:main",
      members: [],
      identities: [],
      role: "owner",
      allowedVisibilities: ["shared"],
      ...result,
    } satisfies SharingResult,
  };
}
const publicShare = { token: `v1.${"a".repeat(96)}`, createdAt: 1 };
const owner = {
  type: "human",
  id: "owner",
  identity: { type: "profile", id: "owner" },
  label: "Owner",
} as const;
function human(id: string, label: string) {
  return { type: "human" as const, id, label };
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

// JSDOM has no visibility API; browser menu tests cover layout and hidden controls.
beforeAll(() => {
  Object.defineProperty(Element.prototype, "checkVisibility", {
    configurable: true,
    value: () => true,
  });
});

afterAll(() => {
  Reflect.deleteProperty(Element.prototype, "checkVisibility");
});

afterEach(() => {
  container?.remove();
  container = undefined;
});

const updates = new WeakMap<HTMLElement, (props: ChatSessionSharingProps) => void>();
const part = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLElement>(`.chat-pane__${name}`);
const item = (root: HTMLElement, value: string) =>
  root.querySelector<HTMLButtonElement>(`button[data-value="${value}"]`);

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
  const panel = part(root, "sharing-panel");
  const trigger = root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger");
  if (panel && trigger && !trigger.disabled && !panel.matches(":popover-open")) {
    trigger.click();
    await waitForSolid(() => expect(panel.matches(":popover-open")).toBe(true));
  }
  return panel;
}

async function select(root: HTMLElement, value: string) {
  await openMenu(root);
  const selected = item(root, value);
  if (!selected) {
    throw new Error(`Expected sharing item: ${value}`);
  }
  selected.click();
  await Promise.resolve();
  flush();
}

async function mount(props: Partial<ChatSessionSharingProps>, open = true) {
  container = document.createElement("div");
  document.body.append(container);
  render(renderSharing(props), container);
  if (open) {
    await openMenu(container);
  }
  return container;
}

describe("chat session sharing menu", () => {
  it("reads people only on opening and retains the latest member rows across reopening", async () => {
    const onOpen = vi.fn();
    const readAvatar = vi.fn(() => undefined);
    const sharing = (count: number, selected = false) =>
      renderSharing({
        onOpen,
        state: sharingState({
          members: selected ? [{ identityId: "person-100", addedBy: "owner", addedAt: 1 }] : [],
          identities: Array.from({ length: count }, (_, index) => ({
            type: "human" as const,
            id: `person-${index}`,
            label: `Person ${index} (${count})`,
            get avatarUrl() {
              return readAvatar();
            },
          })),
          allowedVisibilities: ["shared", "read-only"],
        }),
      });
    const root = await mount(sharing(100), false);
    expect(part(root, "sharing-trigger")).not.toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    expect(readAvatar).not.toHaveBeenCalled();
    render(sharing(101), root);
    expect(onOpen).not.toHaveBeenCalled();
    const panel = (await openMenu(root))!;
    expect(panel.matches(":popover-open")).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(readAvatar).toHaveBeenCalled();
    expect(root.querySelectorAll(".chat-pane__sharing-member")).toHaveLength(101);
    const member = item(root, "member:person-100");
    const avatar = member?.querySelector("openclaw-session-owner-chip");
    expect(avatar).not.toBeNull();
    render({ ...sharing(102, true), memberRemoveDisabledReason: "Requires write" }, root);
    expect(item(root, "member:person-100")).toBe(member);
    expect(member?.querySelector("openclaw-session-owner-chip")).toBe(avatar);
    expect(member).toMatchObject({ title: "Requires write" });
    expect(member && part(member, "sharing-member-label")?.textContent).toBe("Person 100 (102)");
    expect(member?.querySelector('[aria-label="Member"]')).not.toBeNull();
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    await openMenu(root);
    expect(item(root, "member:person-100")).toBe(member);
    const search = root.querySelector<HTMLInputElement>("input[data-search]")!;
    search.focus();
    search.value = "Person 101";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(root.querySelector("input[data-search]")).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(root.querySelectorAll(".chat-pane__sharing-member")).toHaveLength(1);
  });

  it("keeps a world-readable draft session visibly public after its menu closes", async () => {
    const session = sharingSession({ visibility: "draft" });
    const state = sharingState({
      allowedVisibilities: ["draft", "read-only"],
      publicShare,
    });
    const renderIndicator = (published: boolean) =>
      renderSharing({
        session,
        state: published ? state : sharingState({ ...state.result, publicShare: undefined }),
        onPublicShareChange: vi.fn(),
      });
    const root = await mount(renderIndicator(true));

    const panel = part(root, "sharing-panel")!;
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    const indicator = part(root, "public-share-indicator");
    expect(indicator?.textContent?.trim()).toBe("Public");
    expect(indicator?.getAttribute("aria-label")).toContain("anyone can read");

    render(renderIndicator(false), root);
    expect(part(root, "public-share-indicator")).toBeNull();
  });

  it("keeps disabling public access separate from team visibility", async () => {
    const onPublicShareChange = vi.fn();
    const onCopyPublicLink = vi.fn();
    const onVisibilityChange = vi.fn();
    const root = await mount({
      session: sharingSession({ visibility: "draft" }),
      state: sharingState({
        allowedVisibilities: ["draft", "shared"],
        publicShare,
      }),
      onVisibilityChange,
      onPublicShareChange,
      onCopyPublicLink,
    });
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
      const root = await mount({
        session: sharingSession({ sharingRole: blocked === "member" ? "member" : "owner" }),
        state: sharingState({}, blocked === "loading"),
        publicShareDisabledReason: blocked === "read-only" ? "Requires write" : undefined,
        onPublicShareChange,
      });
      const dropdown = part(root, "sharing-panel");
      if (blocked === "member") {
        expect(dropdown).toBeNull();
      } else {
        expect(item(root, "public:enable")).toMatchObject({ disabled: true });
        await select(root, "public:enable");
      }
      expect(onPublicShareChange).not.toHaveBeenCalled();
    },
  );

  it("shows the owner picker with policy-gated modes and known identities", async () => {
    const onVisibilityChange = vi.fn();
    const onMemberChange = vi.fn();
    const navigate = vi.fn();
    const root = await mount({
      session: sharingSession({ visibility: "read-only" }),
      state: sharingState({
        owner,
        identities: [human("owner", "Owner"), human("alice", "Alice")],
        allowedVisibilities: ["shared", "read-only"],
      }),
      ownerViewing: false,
      personActivity: { basePath: "", navigate },
      onVisibilityChange,
      onMemberChange,
    });
    expect(part(root, "sharing-panel")).not.toBeNull();
    expect(root.textContent).toContain("Shared");
    expect(root.textContent).toContain("Read-only");
    expect(root.textContent).not.toContain("Suggest");
    expect(root.textContent).toContain("Alice");
    expect(item(root, "member:owner")).toBeNull();
    expect(part(root, "sharing-owner-title")?.textContent?.trim()).toBe("Owner");
    const ownerRow = part(root, "sharing-owner")!;
    expect(ownerRow.querySelector(".session-menu__text")?.textContent?.trim()).toBe("Owner");
    expect(ownerRow.querySelector("openclaw-session-owner-chip")).not.toBeNull();
    const ownerLink = ownerRow.querySelector<HTMLAnchorElement>("a.person-activity-link");
    expect(ownerLink?.getAttribute("href")).toBe("/activity/owner");
    const ownerAvatarLink = ownerRow.querySelector("a.person-activity-avatar-link");
    expect(ownerAvatarLink).toMatchObject({ tabIndex: -1 });
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
    const root = await mount({
      state: sharingState({
        identities: [
          human("profile-vyctor", "Vyctor Brzezowski"),
          // Human IDs are opaque; recorded type, not ID spelling, drives presentation.
          human("channel:chn_design", "Design"),
          { type: "agent", id: "discord:channel:operations", label: "Operations" },
          { type: "system", id: "channel:audit", label: "Audit" },
        ],
      }),
    });

    for (const id of ["profile-vyctor", "channel:chn_design"]) {
      expect(
        item(root, `member:${id}`)?.querySelector("openclaw-session-owner-chip"),
      ).not.toBeNull();
    }
    for (const id of ["discord:channel:operations", "channel:audit"]) {
      const nonHuman = item(root, `member:${id}`);
      expect(nonHuman?.querySelector("openclaw-session-owner-chip")).toBeNull();
      expect(nonHuman?.querySelector(".chat-pane__sharing-member-icon svg")).not.toBeNull();
    }
  });

  it("keeps the linked owner beside the draft marker for a non-manager", async () => {
    const root = await mount({
      session: sharingSession({
        visibility: "draft",
        sharingRole: "member",
        owner: { actor: owner },
      }),
      ownerViewing: false,
      personActivity: { basePath: "", navigate: vi.fn() },
      showOwner: true,
    });
    expect(part(root, "sharing-panel")).toBeNull();
    const indicator = part(root, "draft-indicator");
    expect(indicator?.querySelector("svg")).not.toBeNull();
    expect(indicator?.textContent?.trim()).toBe("");
    const ownerLink = root.querySelector<HTMLAnchorElement>(
      "a.person-activity-avatar-link:has(openclaw-session-owner-chip)",
    );
    expect(ownerLink?.getAttribute("href")).toBe("/activity/owner");
    expect(ownerLink).toMatchObject({ tabIndex: 0 });
    expect(ownerLink?.hasAttribute("aria-hidden")).toBe(false);
    ownerLink?.focus();
    expect(document.activeElement).toBe(ownerLink);
  });

  it("keeps read-only owner controls visible but refuses disabled selections", async () => {
    const onOpen = vi.fn();
    const onVisibilityChange = vi.fn();
    const onMemberChange = vi.fn();
    const root = await mount({
      state: sharingState({
        members: [{ identityId: "alice", addedBy: "owner", addedAt: 1 }],
        identities: [
          human("alice", "Alice with a very long selected member display name"),
          human("bob", "Bob with a very long available member display name"),
        ],
        allowedVisibilities: ["shared", "read-only"],
      }),
      visibilityDisabledReason: "Requires write",
      memberAddDisabledReason: "Requires write",
      memberRemoveDisabledReason: "Requires write",
      onOpen,
      onVisibilityChange,
      onMemberChange,
    });
    expect(part(root, "sharing-panel")).not.toBeNull();
    expect(item(root, "visibility:read-only")).toMatchObject({ title: "Requires write" });
    for (const identityId of ["alice", "bob"]) {
      const member = item(root, `member:${identityId}`)!;
      expect(member).toMatchObject({ disabled: true, title: "Requires write" });
      expect(part(member, "sharing-member-label")?.hasAttribute("title")).toBe(false);
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
    const root = await mount({
      openDisabledReason: "Connect to the Gateway",
      onOpen,
    });

    expect(root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.disabled).toBe(
      true,
    );
    root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.click();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps visibility controls usable without member-list support", async () => {
    const onOpen = vi.fn();
    const onVisibilityChange = vi.fn();
    const root = await mount({
      allowedVisibilities: ["shared", "read-only"],
      membersAvailable: false,
      onOpen,
      onVisibilityChange,
    });

    expect(root.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.disabled).toBe(
      false,
    );
    expect(item(root, "visibility:read-only")).not.toBeNull();
    expect(root.textContent).not.toContain("People");

    await select(root, "visibility:read-only");

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onVisibilityChange).toHaveBeenCalledWith("read-only");
  });

  it("shows rejected sharing changes for visibility-only Gateways", async () => {
    const root = await mount({
      state: { loading: false, error: "Visibility update rejected" },
      allowedVisibilities: ["shared", "read-only"],
      membersAvailable: false,
    });

    const error = part(root, "sharing-status--error");
    expect(error?.textContent).toContain("Visibility update rejected");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(root.querySelectorAll(".chat-pane__sharing-title")).toHaveLength(1);
  });
});
