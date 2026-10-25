import { flush } from "solid-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatSessionSharingProps } from "./chat-session-sharing-shared.tsx";
import { ChatSessionSharing } from "./chat-session-sharing.solid.tsx";

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
      permissions: [],
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
function permission(
  identityId: string,
  level: "read" | "send" = "read",
  options: ("read" | "send")[] = ["read", "send"],
) {
  return { identityId, level, options };
}
function aliceRoster(overrides: Partial<SharingResult> = {}) {
  return sharingState({
    identities: [human("alice", "Alice")],
    permissions: [permission("alice")],
    ...overrides,
  });
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

const updates = new WeakMap<HTMLElement, ReturnType<typeof mountSolid<ChatSessionSharingProps>>>();
const part = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLElement>(`.chat-pane__${name}`);
const item = (root: HTMLElement, value: string) =>
  root.querySelector<HTMLButtonElement>(`button[data-value="${value}"]`);
const query = <T extends Element = HTMLElement>(root: HTMLElement, selector: string): T | null =>
  root.querySelector<T>(selector);
const memberRow = (root: HTMLElement, id: string) => query(root, `[data-value="member:${id}"]`);
const alert = (root: HTMLElement) => query(root, '[role="alert"]');
const trigger = (root: HTMLElement) =>
  query<HTMLButtonElement>(root, ".chat-pane__sharing-trigger")!;

function render(props: ChatSessionSharingProps, root: HTMLElement) {
  const view = updates.get(root);
  if (view) {
    view.update(props);
  } else {
    updates.set(root, mountSolid(ChatSessionSharing, props, root));
  }
}

async function openMenu(root: HTMLElement) {
  const panel = part(root, "sharing-panel");
  const toggle = trigger(root);
  if (panel && toggle && !toggle.disabled && !panel.matches(":popover-open")) {
    toggle.click();
    await waitForSolid(() => {
      expect(panel.matches(":popover-open")).toBe(true);
      expect(panel.querySelector('[data-value="access"]')).not.toBeNull();
    });
  }
  return panel;
}

async function openAccess(root: HTMLElement) {
  const panel = part(root, "sharing-panel")!;
  if (!panel.querySelector('[data-value="access:back"]')) {
    const access = item(panel, "access");
    expect(access).not.toBeNull();
    access!.click();
  }
  await waitForSolid(() => {
    expect(panel.matches(":popover-open")).toBe(true);
    expect(item(panel, "access:back")?.textContent).toBe("Back");
    expect(panel.querySelectorAll('[data-value^="visibility:"]')).toHaveLength(4);
    expect(item(panel, "access")).toBeNull();
    expect(part(panel, "sharing-permissions")).toBeNull();
  });
}

async function backToOverview(root: HTMLElement) {
  const panel = part(root, "sharing-panel")!;
  const back = item(panel, "access:back");
  expect(back).not.toBeNull();
  back!.click();
  await waitForSolid(() => {
    expect(panel.matches(":popover-open")).toBe(true);
    expect(item(panel, "access")).not.toBeNull();
    expect(item(panel, "access:back")).toBeNull();
    expect(panel.querySelectorAll('[data-value^="visibility:"]')).toHaveLength(0);
    expect(document.activeElement).toBe(item(panel, "access"));
  });
}

async function select(root: HTMLElement, value: string) {
  await openMenu(root);
  if (value.startsWith("visibility:")) {
    await openAccess(root);
  }
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
  it("reads people on opening and retains roster and search across reopening and failed refresh", async () => {
    const onOpen = vi.fn();
    const readAvatar = vi.fn(() => undefined);
    const sharing = (count: number, selected = false) =>
      renderSharing({
        session: sharingSession({ visibility: "read-only" }),
        onOpen,
        state: sharingState({
          members: selected ? [{ identityId: "person-100", addedBy: "owner", addedAt: 1 }] : [],
          permissions: Array.from({ length: count }, (_, index) => ({
            identityId: `person-${index}`,
            level: selected && index === 100 ? ("send" as const) : ("read" as const),
            options: ["read", "send"] as ("read" | "send")[],
          })),
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
    const initialRead = createDeferred();
    render({ ...sharing(101), state: { loading: false, read: initialRead.promise } }, root);
    const panel = (await openMenu(root))!;
    expect(panel.matches(":popover-open")).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(root.querySelector('[role="status"][aria-label="Loading…"]')).not.toBeNull();
    expect(item(root, "permission:person-100")).toBeNull();
    render(sharing(101), root);
    initialRead.resolve();
    await waitForSolid(() => expect(item(root, "permission:person-100")).not.toBeNull());
    expect(readAvatar).toHaveBeenCalled();
    expect(root.querySelectorAll(".chat-pane__sharing-person")).toHaveLength(101);
    const member = memberRow(root, "person-100");
    const avatar = member?.querySelector("openclaw-session-owner-chip");
    expect(avatar).not.toBeNull();
    render({ ...sharing(102, true), memberRemoveDisabledReason: "Requires write" }, root);
    expect(memberRow(root, "person-100")).toBe(member);
    expect(member?.querySelector("openclaw-session-owner-chip")).toBe(avatar);
    expect(item(root, "permission:person-100")).toMatchObject({ title: "Requires write" });
    expect(member && part(member, "sharing-member-label")?.textContent).toBe("Person 100 (102)");
    expect(item(root, "permission:person-100")?.getAttribute("aria-label")).toContain("Can send");
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    await openMenu(root);
    expect(memberRow(root, "person-100")).toBe(member);
    root.querySelector<HTMLButtonElement>('[aria-label="Search people…"]')!.click();
    flush();
    const search = root.querySelector<HTMLInputElement>("input[data-search]")!;
    expect(document.activeElement).toBe(search);
    search.value = "Person 101";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(root.querySelector("input[data-search]")).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(root.querySelectorAll(".chat-pane__sharing-person")).toHaveLength(1);
    const visible = memberRow(root, "person-101");
    const expectRetained = () => {
      expect(memberRow(root, "person-101")).toBe(visible);
      expect(root.querySelector("input[data-search]")).toBe(search);
      expect(search.value).toBe("Person 101");
    };
    const ready = sharing(102, true);
    const refresh = createDeferred();
    render({ ...ready, state: { ...ready.state!, loading: true, read: refresh.promise } }, root);
    expectRetained();
    render({ ...ready, state: { ...ready.state!, error: "Membership refresh failed" } }, root);
    refresh.resolve();
    await waitForSolid(() =>
      expect(alert(root)?.textContent).toContain("Membership refresh failed"),
    );
    expectRetained();
    const retry = createDeferred();
    render({ ...ready, state: { ...ready.state!, loading: true, read: retry.promise } }, root);
    render(ready, root);
    retry.resolve();
    await waitForSolid(() => expect(alert(root)).toBeNull());
    expectRetained();
  });

  it("uses server choices for editable opaque human IDs and inherited participation", async () => {
    const onMemberChange = vi.fn();
    const result = {
      owner,
      identities: [
        human("owner", "Owner"),
        human("channel:chn_design", "Alex"),
        human("inherited", "Morgan"),
      ],
      permissions: [
        permission("owner", "send", ["send"]),
        permission("channel:chn_design"),
        permission("inherited", "send", ["send"]),
      ],
    };
    const props = renderSharing({
      session: sharingSession({ visibility: "read-only" }),
      state: sharingState(result),
      onMemberChange,
    });
    const root = await mount(props);
    expect(root.querySelectorAll('[data-value="member:owner"]')).toHaveLength(1);
    expect(item(root, "permission:inherited")).toBeNull();
    const inherited = memberRow(root, "inherited")!;
    expect(part(inherited, "sharing-permission")?.textContent).toBe("Can send");
    const editable = item(root, "permission:channel:chn_design")!;
    expect(editable.textContent).toBe("Can read");
    expect(
      memberRow(root, "channel:chn_design")?.querySelector("openclaw-session-owner-chip"),
    ).not.toBeNull();
    expect(onMemberChange).not.toHaveBeenCalled();
    editable.click();
    await waitForSolid(() =>
      expect(item(root, "permission:send:channel:chn_design")).not.toBeNull(),
    );
    item(root, "permission:send:channel:chn_design")!.click();
    expect(onMemberChange).toHaveBeenLastCalledWith("channel:chn_design", true);
    render(
      {
        ...props,
        state: sharingState({
          ...result,
          permissions: [permission("channel:chn_design", "send"), result.permissions[2]!],
        }),
      },
      root,
    );
    await waitForSolid(() => expect(editable.textContent).toBe("Can send"));
    editable.click();
    await waitForSolid(() =>
      expect(item(root, "permission:read:channel:chn_design")).not.toBeNull(),
    );
    const readOption = item(root, "permission:read:channel:chn_design")!;
    readOption.click();
    expect(onMemberChange).toHaveBeenLastCalledWith("channel:chn_design", false);
    render({ ...props, session: sharingSession({ visibility: "shared" }) }, root);
    expect(part(root, "sharing-permissions")).toBeNull();
    expect(item(root, "permission:channel:chn_design")).toBeNull();
    expect(root.querySelector('[aria-label="Search people…"]')).toBeNull();
    readOption.click();
    expect(onMemberChange).toHaveBeenCalledTimes(2);
    render({ ...props, session: sharingSession({ visibility: "suggest" }) }, root);
    expect(item(root, "permission:channel:chn_design")).not.toBeNull();
    expect(root.querySelector('[aria-label="Search people…"]')).not.toBeNull();
  });

  it("keeps public draft access separate from team visibility through copy and disable", async () => {
    const onPublicShareChange = vi.fn();
    const onCopyPublicLink = vi.fn();
    const onVisibilityChange = vi.fn();
    const session = sharingSession({ visibility: "draft" });
    const state = sharingState({
      allowedVisibilities: ["draft", "read-only"],
      publicShare,
    });
    const renderIndicator = (published: boolean) =>
      renderSharing({
        session,
        state: published ? state : sharingState({ ...state.result, publicShare: undefined }),
        onPublicShareChange,
        onCopyPublicLink,
        onVisibilityChange,
      });
    const root = await mount(renderIndicator(true));
    expect(part(root, "sharing-permissions")).toBeNull();
    expect(root.querySelector('[aria-label="Search people…"]')).toBeNull();

    const panel = part(root, "sharing-panel")!;
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flush();
    expect(panel.matches(":popover-open")).toBe(false);
    const indicator = root.querySelector('.chat-pane__sharing-trigger[data-public="true"]');
    expect(indicator?.textContent?.trim()).toBe("Public");
    expect(indicator?.getAttribute("title")).toContain("anyone can read");
    await select(root, "public:disable");
    expect(onPublicShareChange).toHaveBeenCalledWith(false);
    expect(onVisibilityChange).not.toHaveBeenCalled();
    await select(root, "public:copy");
    expect(onCopyPublicLink).toHaveBeenCalledOnce();
    expect(part(root, "sharing-panel")?.matches(":popover-open")).toBe(true);
    expect(root.textContent).toContain("Link sharing");
    expect(root.textContent).toContain("The public link stays readable in Draft.");
    render(renderIndicator(false), root);
    expect(root.querySelector('.chat-pane__sharing-trigger[data-public="true"]')).toBeNull();
  });

  it("keeps the empty permissions status on command failure and clears it during retry", async () => {
    const retry = createDeferred<{ status: "success" }>();
    const onPublicShareChange = vi
      .fn()
      .mockRejectedValueOnce(new Error("Sharing command failed"))
      .mockReturnValueOnce(retry.promise);
    const root = await mount({
      session: sharingSession({ visibility: "read-only" }),
      state: sharingState(),
      onPublicShareChange,
    });
    const toggle = query<HTMLButtonElement>(root, ".chat-pane__sharing-public-toggle")!;
    expect(part(root, "sharing-permissions")).toBeNull();
    toggle.click();
    await waitForSolid(() => {
      expect(alert(root)?.textContent).toContain("Sharing command failed");
      expect(part(root, "sharing-permissions")).not.toBeNull();
      expect(part(root, "sharing-empty")).not.toBeNull();
    });
    toggle.click();
    await waitForSolid(() => {
      expect(alert(root)).toBeNull();
      expect(part(root, "sharing-permissions")).toBeNull();
      expect(toggle.disabled).toBe(true);
    });
    retry.resolve({ status: "success" });
    await waitForSolid(() => expect(toggle.disabled).toBe(false));
  });

  it("retains the copy control and clears its failure while a retry is pending", async () => {
    const retry = createDeferred<{ status: "success" }>();
    const onCopyPublicLink = vi
      .fn()
      .mockResolvedValueOnce({ status: "failed", error: "Clipboard unavailable" })
      .mockReturnValueOnce(retry.promise);
    const root = await mount({
      state: { ...sharingState({ publicShare }), publicUrl: "https://example.test/shared" },
      onCopyPublicLink,
    });
    const copy = item(root, "public:copy")!;
    copy.click();
    await waitForSolid(() => expect(alert(root)?.textContent).toContain("Clipboard unavailable"));
    expect(item(root, "public:copy")).toBe(copy);
    copy.click();
    await waitForSolid(() => {
      expect(alert(root)).toBeNull();
      expect(copy.disabled).toBe(true);
    });
    retry.resolve({ status: "success" });
    await waitForSolid(() => expect(copy.getAttribute("aria-label")).toBe("Copied!"));
    expect(item(root, "public:copy")).toBe(copy);
    expect(copy.disabled).toBe(false);
    expect(part(root, "sharing-panel")?.matches(":popover-open")).toBe(true);
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
      state: aliceRoster({
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
    await openAccess(root);
    expect(root.textContent).toContain("Shared");
    expect(root.textContent).toContain("Read-only");
    expect(item(root, "visibility:suggest")?.disabled).toBe(true);
    await backToOverview(root);
    expect(root.textContent).toContain("Alice");
    expect(item(root, "member:owner")).toBeNull();
    const ownerRow = part(root, "sharing-person--creator")!;
    expect(ownerRow.textContent).toContain("Owner");
    expect(ownerRow.querySelector("openclaw-session-owner-chip")).not.toBeNull();
    const ownerLink = query<HTMLAnchorElement>(ownerRow, "a.person-activity-link");
    expect(ownerLink?.getAttribute("href")).toBe("/activity/owner");
    const ownerAvatarLink = ownerRow.querySelector("a.person-activity-avatar-link");
    expect(ownerAvatarLink).toMatchObject({ tabIndex: -1 });
    expect(ownerAvatarLink?.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector(".session-menu__separator")).toBeNull();

    ownerLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledWith("owner", "Owner");

    await select(root, "visibility:shared");
    await backToOverview(root);
    const access = item(root, "access")!;
    const member = item(root, "permission:alice")!;
    access.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    await waitForSolid(() => expect(document.activeElement).toBe(member));
    member.click();
    await waitForSolid(() => expect(item(root, "permission:send:alice")).not.toBeNull());
    item(root, "permission:send:alice")!.click();
    await waitForSolid(() => expect(onMemberChange).toHaveBeenCalledExactlyOnceWith("alice", true));
    expect(onVisibilityChange).toHaveBeenCalledWith("shared");
    expect(part(root, "sharing-panel")?.matches(":popover-open")).toBe(true);
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
    const ownerLink = query<HTMLAnchorElement>(
      root,
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
      session: sharingSession({ visibility: "read-only" }),
      state: sharingState({
        members: [{ identityId: "alice", addedBy: "owner", addedAt: 1 }],
        permissions: [permission("alice", "send"), permission("bob")],
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
    await openAccess(root);
    expect(item(root, "visibility:read-only")).toMatchObject({ title: "Requires write" });
    await backToOverview(root);
    for (const identityId of ["alice", "bob"]) {
      const member = item(root, `permission:${identityId}`)!;
      expect(member).toMatchObject({ disabled: true, title: "Requires write" });
      expect(
        memberRow(root, identityId)
          ?.querySelector(".chat-pane__sharing-member-label")
          ?.hasAttribute("title"),
      ).toBe(false);
    }

    await select(root, "visibility:read-only");
    await backToOverview(root);
    await select(root, "permission:alice");
    await select(root, "permission:bob");

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

    expect(trigger(root).disabled).toBe(true);
    trigger(root).click();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps visibility-only controls usable through failure and a held retry", async () => {
    const onOpen = vi.fn();
    const failed = createDeferred();
    const retry = createDeferred();
    const onVisibilityChange = vi
      .fn()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retry.promise);
    const props = renderSharing({
      allowedVisibilities: ["shared", "read-only"],
      membersAvailable: false,
      onOpen,
      onVisibilityChange,
    });
    const root = await mount(props);

    expect(trigger(root).disabled).toBe(false);
    expect(part(root, "sharing-permissions")).toBeNull();
    expect(root.textContent).not.toContain("Permissions");
    await openAccess(root);
    expect(item(root, "visibility:read-only")).not.toBeNull();

    await select(root, "visibility:read-only");
    const button = item(root, "visibility:read-only");
    expect(button?.disabled).toBe(true);
    failed.reject(new Error("Sharing command rejected"));
    await waitForSolid(() => {
      expect(alert(root)?.textContent).toContain("Sharing command rejected");
      expect(button?.disabled).toBe(false);
    });
    button!.click();
    await waitForSolid(() => {
      expect(alert(root)).toBeNull();
      expect(item(root, "visibility:read-only")).toBe(button);
      expect(button?.disabled).toBe(true);
    });
    retry.resolve();
    await waitForSolid(() => expect(button?.disabled).toBe(false));
    expect(item(root, "visibility:read-only")).toBe(button);
    await backToOverview(root);
    expect(part(root, "sharing-permissions")).toBeNull();
    expect(root.textContent).not.toContain("Permissions");
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onVisibilityChange).toHaveBeenCalledWith("read-only");
    render({ ...props, state: { loading: false, error: "Visibility update rejected" } }, root);
    const error = part(root, "sharing-status--error");
    expect(error?.textContent).toContain("Visibility update rejected");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(root.textContent).toContain("Session access");
  });
});
