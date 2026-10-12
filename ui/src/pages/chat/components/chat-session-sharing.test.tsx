import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
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
}

function mount(props: ChatSessionSharingProps) {
  container = document.createElement("div");
  document.body.append(container);
  render(props, container);
  return container;
}

describe("chat session sharing menu", () => {
  it.each(["draft"] as const)(
    "keeps a world-readable %s session visibly public after its menu closes",
    (visibility) => {
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
      const root = mount(renderIndicator(true));

      const indicator = root.querySelector(".chat-pane__public-share-indicator");
      expect(indicator?.textContent?.trim()).toBe("Public");
      expect(indicator?.getAttribute("aria-label")).toContain("anyone can read");

      render(renderIndicator(false), root);
      expect(root.querySelector(".chat-pane__public-share-indicator")).toBeNull();
    },
  );

  it("keeps disabling public access separate from team visibility", () => {
    const onPublicShareChange = vi.fn();
    const onCopyPublicLink = vi.fn();
    const onVisibilityChange = vi.fn();
    const root = mount(
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
    const dropdown = root.querySelector("wa-dropdown");
    expect(root.textContent).toContain("Public access");
    expect(root.textContent).toContain("anyone can read without signing in");
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "public:disable" } },
      }),
    );
    expect(onPublicShareChange).toHaveBeenCalledWith(false);
    expect(onVisibilityChange).not.toHaveBeenCalled();
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", { detail: { item: { value: "public:copy" } } }),
    );
    expect(onCopyPublicLink).toHaveBeenCalledOnce();
  });

  it.each(["loading", "read-only", "member"] as const)(
    "refuses public mutations for %s controls",
    (blocked) => {
      const onPublicShareChange = vi.fn();
      const root = mount(
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
      const dropdown = root.querySelector("wa-dropdown");
      if (blocked === "member") {
        expect(dropdown).toBeNull();
      } else {
        expect(root.querySelector('[value="public:enable"]')?.hasAttribute("disabled")).toBe(true);
        dropdown?.dispatchEvent(
          new CustomEvent("wa-select", { detail: { item: { value: "public:enable" } } }),
        );
      }
      expect(onPublicShareChange).not.toHaveBeenCalled();
    },
  );

  it("shows the owner picker with policy-gated modes and known identities", () => {
    const onVisibilityChange = vi.fn();
    const onMemberChange = vi.fn();
    const navigate = vi.fn();
    const root = mount(
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
    const dropdown = root.querySelector("wa-dropdown");
    expect(dropdown).not.toBeNull();
    expect(root.textContent).toContain("Shared");
    expect(root.textContent).toContain("Read-only");
    expect(root.textContent).not.toContain("Suggest");
    expect(root.textContent).toContain("Alice");
    expect(root.querySelector('wa-dropdown-item[value="member:owner"]')).toBeNull();
    expect(root.querySelector(".chat-pane__sharing-owner-title")?.textContent?.trim()).toBe(
      "Owner",
    );
    expect(root.querySelector(".chat-pane__sharing-owner")?.textContent?.trim()).toBe("Owner");
    expect(
      root.querySelector(".chat-pane__sharing-owner openclaw-session-owner-chip"),
    ).not.toBeNull();
    const ownerLink = root.querySelector<HTMLAnchorElement>(
      ".chat-pane__sharing-owner a.person-activity-link",
    );
    expect(ownerLink?.getAttribute("href")).toBe("/activity/owner");
    expect(root.querySelector(".session-menu__separator")).toBeNull();

    ownerLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledWith("owner", "Owner");

    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "visibility:shared" } },
      }),
    );
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "member:alice" } },
      }),
    );
    expect(onVisibilityChange).toHaveBeenCalledWith("shared");
    expect(onMemberChange).toHaveBeenCalledWith("alice", true);
  });

  it("renders member presentation from identity.type, not from ID spelling", () => {
    const root = mount(
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
      root.querySelector('wa-dropdown-item[value="member:profile-vyctor"]'),
      root.querySelector('wa-dropdown-item[value="member:channel:chn_design"]'),
    ];
    const nonHumans = [
      root.querySelector('wa-dropdown-item[value="member:discord:channel:operations"]'),
      root.querySelector('wa-dropdown-item[value="member:channel:audit"]'),
    ];

    for (const human of humans) {
      expect(human?.querySelector("openclaw-session-owner-chip")).not.toBeNull();
    }
    for (const nonHuman of nonHumans) {
      expect(nonHuman?.querySelector("openclaw-session-owner-chip")).toBeNull();
      expect(nonHuman?.querySelector(".chat-pane__sharing-member-icon svg")).not.toBeNull();
    }
  });

  it("keeps the linked owner beside the draft marker for a non-manager", () => {
    const root = mount(
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
    expect(root.querySelector("wa-dropdown")).toBeNull();
    const indicator = root.querySelector(".chat-pane__draft-indicator");
    expect(indicator?.querySelector("svg")).not.toBeNull();
    expect(indicator?.textContent?.trim()).toBe("");
    expect(
      root
        .querySelector("a.person-activity-avatar-link:has(openclaw-session-owner-chip)")
        ?.getAttribute("href"),
    ).toBe("/activity/owner");
  });

  it("keeps read-only owner controls visible but refuses disabled synthetic actions", () => {
    const onOpen = vi.fn();
    const onVisibilityChange = vi.fn();
    const onMemberChange = vi.fn();
    const root = mount(
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
    const dropdown = root.querySelector("wa-dropdown");
    expect(dropdown).not.toBeNull();
    expect(
      root.querySelector<HTMLElement>('wa-dropdown-item[value="visibility:read-only"]')?.title,
    ).toBe("Requires write");
    expect(
      root.querySelector('wa-dropdown-item[value="member:alice"]')?.hasAttribute("disabled"),
    ).toBe(true);
    expect(
      root.querySelector('wa-dropdown-item[value="member:bob"]')?.hasAttribute("disabled"),
    ).toBe(true);
    for (const identityId of ["alice", "bob"]) {
      const item = root.querySelector<HTMLElement>(
        `wa-dropdown-item[value="member:${identityId}"]`,
      );
      expect(item?.title).toBe("Requires write");
      expect(item?.querySelector(".chat-pane__sharing-member-label")?.hasAttribute("title")).toBe(
        false,
      );
    }

    dropdown?.dispatchEvent(new CustomEvent("wa-show"));
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "visibility:read-only" } },
      }),
    );
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "member:alice" } },
      }),
    );
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "member:bob" } },
      }),
    );

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onVisibilityChange).not.toHaveBeenCalled();
    expect(onMemberChange).not.toHaveBeenCalled();
  });

  it("disables opening when sharing reads are unavailable", () => {
    const onOpen = vi.fn();
    const root = mount(
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
    root.querySelector("wa-dropdown")?.dispatchEvent(new CustomEvent("wa-show"));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("keeps visibility controls usable without member-list support", () => {
    const onOpen = vi.fn();
    const onVisibilityChange = vi.fn();
    const root = mount(
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
    expect(root.querySelector('wa-dropdown-item[value="visibility:read-only"]')).not.toBeNull();
    expect(root.textContent).not.toContain("People");

    const dropdown = root.querySelector("wa-dropdown");
    dropdown?.dispatchEvent(new CustomEvent("wa-show"));
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "visibility:read-only" } },
      }),
    );

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onVisibilityChange).toHaveBeenCalledWith("read-only");
  });

  it.each([{ name: "visibility-only", membersAvailable: false }])(
    "shows rejected sharing changes for $name Gateways",
    ({ membersAvailable }) => {
      const root = mount(
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
