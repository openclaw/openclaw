import { html, render } from "lit";
/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { GatewaySessionRow, PresenceEntry, SessionsListResult } from "../../../api/types.ts";
import {
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type ShellNavDrawerToggleDetail,
} from "../../../components/command-palette-contract.ts";
import { resolveSessionWorkspace } from "../../../lib/sessions/workspace.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import {
  activePlacementSession,
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createSessionContext,
  createTestChatPane,
} from "../chat-pane.test-support.ts";
import type { ChatPageHost } from "../chat-state-host.ts";
import {
  chatPaneHeaderSessionRow as row,
  mountChatPaneHeader,
  mockWorkspaceIconFetch,
  type ChatPaneHeaderProps,
} from "./chat-pane-header.test-support.ts";
import {
  canRevealSessionWorkspace,
  renderChatPaneHeader,
  resolveChatPaneParentSession,
  resolveChatPaneWorkspaceIcon,
} from "./chat-pane-header.ts";
import { renderChatPanePlacement } from "./chat-pane-placement.ts";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_WEB_CHROME__");
});

function mountHeader(patch: Partial<ChatPaneHeaderProps> = {}) {
  return mountChatPaneHeader(containers, patch);
}

function mountIntegratedPresenceHeader(params: {
  owners: NonNullable<SessionsListResult["owners"]>;
  presence: PresenceEntry[];
}) {
  const client = { instanceId: "self-instance" } as unknown as GatewayBrowserClient;
  const { pane, state } = createTestChatPane({
    client,
    sessions: createSessionCapabilityFixture(),
  });
  const actor = {
    type: "human" as const,
    id: "profile-ada",
    identity: { type: "profile" as const, id: "profile-ada" },
    label: "Ada",
  };
  const session = row({
    key: state.sessionKey,
    createdActor: actor,
    owner: { actor },
  });
  state.settings = {} as ChatPageHost["settings"];
  state.sessionsResult = {
    ts: 1,
    path: "",
    count: 1,
    owners: params.owners,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [session],
  };
  pane.context.gateway.snapshot.selfUser = { id: "profile-self" };
  pane.presencePayload = { presence: params.presence };
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const renderHeader = () =>
    render(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        session,
        false,
        undefined,
        false,
        null,
      ),
      container,
    );
  renderHeader();
  return { container, pane, renderHeader };
}

describe("chat pane header", () => {
  it("preserves the merged navigation toggle for catalog sessions", () => {
    const drawerEvents: CustomEvent<ShellNavDrawerToggleDetail>[] = [];
    const onDrawer = (event: Event) =>
      drawerEvents.push(event as CustomEvent<ShellNavDrawerToggleDetail>);
    window.addEventListener(SHELL_NAV_DRAWER_TOGGLE_EVENT, onDrawer);
    const { container } = mountHeader({ mergedChrome: true, catalog: true, session: undefined });
    const drawer = container.querySelector<HTMLButtonElement>('[aria-label="Expand sidebar"]');
    drawer?.click();
    expect(drawer).not.toBeNull();
    expect(drawerEvents).toHaveLength(1);
    expect(drawerEvents[0]?.detail.trigger).toBe(drawer);
    window.removeEventListener(SHELL_NAV_DRAWER_TOGGLE_EVENT, onDrawer);
  });

  it("omits shell chrome actions when the header is not merged", () => {
    const { container } = mountHeader();
    expect(container.querySelector(".chat-pane__nav-toggle")).toBeNull();
    expect(container.querySelector(".chat-pane__palette-open")).toBeNull();
  });

  it("keeps only Share, Layout, and overflow at rest and moves layout actions into the menu", async () => {
    const onClosePane = vi.fn();
    const onSplitDown = vi.fn();
    const onSplitRight = vi.fn();
    const onOpenSplitView = vi.fn();
    const { container, props } = mountHeader({
      onClosePane,
      onSplitDown,
      onSplitRight,
      onOpenSplitView,
      sharingControl: html`<button aria-label="Share">Share</button>`,
      sessionMenuAction: html`<button aria-label="Session actions">…</button>`,
    });
    const actions = container.querySelector(".chat-pane__actions")!;
    expect(
      [...actions.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).toEqual(["Share", "Layout", "…"]);
    const menu = actions.querySelector(".chat-pane__layout-menu")!;
    expect(
      [...menu.querySelectorAll("wa-dropdown-item")].map((item) => item.textContent?.trim()),
    ).toEqual(["Open split view", "Split down", "Split right", "Close pane"]);
    for (const [value, callback, args] of [
      ["open-split-view", onOpenSplitView, []],
      ["split-down", onSplitDown, ["pane-1"]],
      ["split-right", onSplitRight, ["pane-1"]],
      ["close-pane", onClosePane, ["pane-1"]],
    ] as const) {
      menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value } } }));
      expect(callback).not.toHaveBeenCalled();
      menu
        .querySelector("wa-dropdown-item")!
        .dispatchEvent(new Event("wa-after-hide", { bubbles: true }));
      expect(callback).not.toHaveBeenCalled();
      menu.dispatchEvent(new Event("wa-after-hide"));
      menu.dispatchEvent(new Event("wa-after-hide"));
      expect(callback).toHaveBeenCalledExactlyOnceWith(...args);
    }
    render(renderChatPaneHeader({ ...props, onClosePane: undefined }), container);
    expect(container.querySelector(".chat-pane__close-pane")).toBeNull();
  });

  it("keeps available panels in the narrow Layout menu while omitting split actions", () => {
    const onTerminal = vi.fn();
    const { container } = mountHeader({
      narrow: true,
      mergedChrome: true,
      panelMenuActions: [
        { id: "terminal", label: "Terminal", icon: html``, onActivate: onTerminal },
      ],
      sessionMenuAction: html`<button data-action="session-menu"></button>`,
      onOpenSplitView: vi.fn(),
      onSplitDown: vi.fn(),
      onSplitRight: vi.fn(),
    });
    expect(container.querySelector('.chat-pane__layout-menu [value="terminal"]')).not.toBeNull();
    expect(container.querySelector(".chat-pane__split-down")).toBeNull();
    expect(container.querySelector(".chat-pane__split-right")).toBeNull();
    expect(container.querySelector(".chat-pane__nav-toggle")).not.toBeNull();
    const menu = container.querySelector(".chat-pane__layout-menu")!;
    menu.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "terminal" } } }));
    expect(onTerminal).not.toHaveBeenCalled();
    menu.dispatchEvent(new Event("wa-after-hide"));
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("shows the muted running count only while there are active subagents", () => {
    const { container, props } = mountHeader({ runningSubagentCount: 2 });
    expect(container.querySelector(".chat-pane__subagents-running")?.textContent).toContain(
      "Subagents · 2 running",
    );
    render(renderChatPaneHeader({ ...props, runningSubagentCount: 0 }), container);
    expect(container.querySelector(".chat-pane__subagents-running")).toBeNull();
  });

  it("renders a quiet cloud placement chip with move and stop actions", () => {
    const onPlacementMove = vi.fn();
    const onPlacementReclaim = vi.fn();
    const { container } = mountHeader({
      placementControl: renderChatPanePlacement({
        session: activePlacementSession(),
        onPlacementMove,
        onPlacementReclaim,
      }),
    });

    expect(container.querySelector(".chat-pane__placement-chip")?.textContent?.trim()).toBe(
      "Runs on Cloud",
    );
    expect(container.querySelector(".chat-pane__placement-state")).toBeNull();
    expect(container.querySelector(".chat-pane__placement-note")).toBeNull();
    const actions = container.querySelectorAll(".chat-pane__placement-menu wa-dropdown-item");
    expect(actions).toHaveLength(2);
    expect(actions[0]?.textContent?.trim()).toBe("Move session…");
    expect(actions[0]?.classList.contains("session-menu__item--destructive")).toBe(false);
    actions[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPlacementMove).toHaveBeenCalledOnce();
    expect(actions[1]?.textContent?.trim()).toBe("Stop cloud worker…");
    expect(actions[1]?.classList.contains("session-menu__item--destructive")).toBe(true);
    expect(actions[1]?.getAttribute("variant")).toBe("danger");
    expect(actions[1]?.querySelector(".session-menu__icon")).not.toBeNull();
    actions[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPlacementReclaim).toHaveBeenCalledOnce();
  });

  it("shows durable move progress in the placement chip", () => {
    const session = row({
      placement: {
        state: "draining",
        generation: 2,
        createdAtMs: 100_000,
        updatedAtMs: 300_000,
        stateChangedAtMs: 300_000,
        environmentId: "worker:one",
        activeOwnerEpoch: 1,
        workerBundleHash: "a".repeat(64),
        workspaceBaseManifestRef: "base-manifest",
        remoteWorkspaceDir: "/worker/repo",
      },
      placementMove: {
        target: { kind: "gateway" },
        updatedAtMs: 300_000,
      },
    });
    const { container } = mountHeader({
      session,
      placementControl: renderChatPanePlacement({ session }),
    });

    expect(container.querySelector(".chat-pane__placement-chip")?.textContent?.trim()).toBe(
      "Moving to Gateway…",
    );
  });

  it("places placement and presence after the identity trail", () => {
    const { container } = mountHeader({
      placementControl: html`<span data-slot="placement"></span>`,
      presence: html`<span data-slot="presence"></span>`,
    });
    const crumbs = container.querySelector(".chat-pane__crumbs");
    expect(
      [...container.querySelectorAll("[data-slot]")].map((slot) => slot.getAttribute("data-slot")),
    ).toEqual(["placement", "presence"]);
    expect(crumbs?.nextElementSibling?.getAttribute("data-slot")).toBe("placement");
  });

  it("keeps the public indicator visible in narrow headers", () => {
    const narrow = true;
    const { container } = mountHeader({
      narrow,
      publicAccessIndicator: html`<span class="chat-pane__public-share-indicator">Public</span>`,
    });

    expect(container.querySelector(".chat-pane__public-share-indicator")?.textContent).toBe(
      "Public",
    );
  });

  it("replaces the header owner avatar when visibility is available", () => {
    const actor = {
      type: "human" as const,
      id: "profile-ada",
      identity: { type: "profile" as const, id: "profile-ada" },
      label: "Ada",
    };
    const { container } = mountHeader({
      session: row({ owner: { actor } }),
      showOwnerChip: true,
      sharingControl: html`<span data-slot="sharing"></span>`,
    });

    expect(container.querySelector("openclaw-session-owner-chip")).toBeNull();
    expect(container.querySelector('[data-slot="sharing"]')?.parentElement?.className).toBe(
      "chat-pane__actions",
    );
  });

  it("drops the separator when the session has no project segment", () => {
    const { container } = mountHeader({ workspaceLabel: null, workspaceRoot: null });
    expect(container.querySelector(".chat-pane__crumb-sep")).toBeNull();
    const crumbs = container.querySelector(".chat-pane__crumbs");
    expect(crumbs?.firstElementChild?.className).toBe("chat-pane__session-trail");
    expect(crumbs?.querySelector(".chat-pane__session-title")).not.toBeNull();
  });

  it("keeps the rename input inside the trail so the project stays visible", () => {
    const { container } = mountHeader({ editing: true, renameValue: "Renaming" });
    const crumbs = container.querySelector(".chat-pane__crumbs");
    expect(crumbs?.querySelector(".chat-pane__workspace-chip")).not.toBeNull();
    expect(crumbs?.querySelector<HTMLInputElement>(".chat-pane__session-title-input")?.value).toBe(
      "Renaming",
    );
  });

  it("renders the bounded static participant facepile beside the owner", async () => {
    const mounted = mountHeader({
      showOwnerChip: true,
      session: row({
        createdActor: { type: "human", id: "profile-ada", label: "Ada" },
        owner: { actor: { type: "human", id: "profile-ada", label: "Ada" } },
        participants: [
          { identity: { type: "profile", id: "profile-bob" }, label: "Bob" },
          { identity: { type: "agent", id: "research" }, label: "Research" },
        ],
        participantCount: 2,
      }),
    });
    const facepile = mounted.container.querySelector<
      HTMLElement & { updateComplete?: Promise<unknown> }
    >("openclaw-viewer-facepile.chat-pane__participants");
    await facepile?.updateComplete;

    await vi.waitFor(() =>
      expect(facepile?.querySelector(".identity-avatar__agent-face")).not.toBeNull(),
    );
    expect(mounted.container.querySelector("openclaw-session-owner-chip")).not.toBeNull();
    expect(
      [...(facepile?.querySelectorAll(".viewer-avatar") ?? [])].map((avatar) =>
        avatar.getAttribute("aria-label"),
      ),
    ).toEqual(["Bob", "Research"]);
    expect(facepile?.querySelector("[data-viewer-id]")).toBeNull();
  });

  it.each([
    {
      name: "excludes the owner when the owner chip is shown",
      owners: [
        { type: "human" as const, id: "profile-ada", label: "Ada" },
        { type: "human" as const, id: "profile-zoe", label: "Zoe" },
      ],
      viewers: ["profile-ada", "profile-zoe"],
      qualified: true,
      expectedChip: true,
      expectedViewers: ["profile-zoe"],
    },
    {
      name: "keeps the owner when the owner chip is hidden",
      owners: [{ type: "human" as const, id: "profile-ada", label: "Ada" }],
      viewers: ["profile-ada", "profile-zoe"],
      qualified: true,
      expectedChip: false,
      expectedViewers: ["profile-ada", "profile-zoe"],
    },
    {
      name: "omits the facepile when the shown owner is the only viewer",
      owners: [
        { type: "human" as const, id: "profile-ada", label: "Ada" },
        { type: "human" as const, id: "profile-zoe", label: "Zoe" },
      ],
      viewers: ["profile-ada"],
      qualified: true,
      expectedChip: true,
      expectedViewers: [],
    },
    {
      name: "keeps a raw viewer whose ID matches the displayed profile owner",
      owners: [
        { type: "human" as const, id: "profile-ada", label: "Ada" },
        { type: "human" as const, id: "profile-zoe", label: "Zoe" },
      ],
      viewers: ["profile-ada"],
      qualified: false,
      expectedChip: true,
      expectedViewers: ["profile-ada"],
    },
  ])("$name", async ({ owners, viewers, qualified, expectedChip, expectedViewers }) => {
    const sessionKey = "agent:main:current";
    const { container } = mountIntegratedPresenceHeader({
      owners,
      presence: viewers.map((id) => ({
        instanceId: `${id}-instance`,
        ts: 1,
        user: {
          id,
          name: id,
          ...(qualified ? { identity: { type: "profile" as const, id } } : {}),
        },
        watchedSessions: [sessionKey],
      })),
    });
    const ownerChip = container.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
      "openclaw-session-owner-chip",
    );
    const facepile = container.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
      "openclaw-viewer-facepile",
    );

    await Promise.all([ownerChip?.updateComplete, facepile?.updateComplete]);
    expect(ownerChip !== null).toBe(expectedChip);
    expect(
      [...container.querySelectorAll(".viewer-facepile [data-viewer-id]")].map((avatar) =>
        avatar.getAttribute("data-viewer-id"),
      ),
    ).toEqual(expectedViewers);
    expect(facepile !== null).toBe(expectedViewers.length > 0);
  });

  it("keeps header viewers settled until presence changes", async () => {
    const presence: PresenceEntry[] = [
      {
        instanceId: "guest-instance",
        ts: 1,
        user: { id: "guest", identity: { type: "profile", id: "guest" }, name: "Guest" },
        watchedSessions: ["agent:main:current"],
      },
    ];
    const mounted = mountIntegratedPresenceHeader({ owners: [], presence });
    const facepile = mounted.container.querySelector("openclaw-viewer-facepile")!;
    await facepile.updateComplete;
    const updates: MutationRecord[] = [];
    const observer = new MutationObserver((records) => updates.push(...records));
    observer.observe(facepile, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    onTestFinished(() => observer.disconnect());
    mounted.renderHeader();
    await facepile.updateComplete;
    expect(updates).toHaveLength(0);
    mounted.pane.presencePayload = {
      presence: [
        ...presence,
        {
          instanceId: "second-instance",
          ts: 1,
          user: { id: "second", identity: { type: "profile", id: "second" }, name: "Second" },
          watchedSessions: ["agent:main:current"],
        },
      ],
    };
    mounted.renderHeader();
    await facepile.updateComplete;
    expect(updates.length).toBeGreaterThan(0);
    expect(facepile.querySelectorAll("openclaw-viewer-avatar")).toHaveLength(2);
  });

  it("updates the header owner vitality from live session presence", async () => {
    const sessionKey = "agent:main:current";
    const owners = [
      { type: "human" as const, id: "profile-ada", label: "Ada" },
      { type: "human" as const, id: "profile-zoe", label: "Zoe" },
    ];
    const guest = {
      instanceId: "profile-zoe-instance",
      ts: 1,
      user: {
        id: "profile-zoe",
        identity: { type: "profile", id: "profile-zoe" },
        name: "Zoe",
      },
      watchedSessions: [sessionKey],
    } satisfies PresenceEntry;
    const mounted = mountIntegratedPresenceHeader({ owners, presence: [guest] });
    const ownerChip = mounted.container.querySelector<
      HTMLElement & { updateComplete?: Promise<unknown> }
    >("openclaw-session-owner-chip");

    await ownerChip?.updateComplete;
    expect(mounted.container.querySelector(".session-owner-chip--header")?.classList).toContain(
      "session-owner-chip--away",
    );
    for (const identity of [undefined, { type: "profile" as const, id: "profile-ada" }]) {
      mounted.pane.presencePayload = {
        presence: [
          {
            instanceId: "profile-ada-instance",
            ts: 1,
            user: { id: "profile-ada", identity, name: "Ada" },
            watchedSessions: [sessionKey],
          },
          guest,
        ],
      };
      mounted.renderHeader();
      await ownerChip?.updateComplete;
      expect(
        mounted.container
          .querySelector(".session-owner-chip--header")
          ?.classList.contains("session-owner-chip--away"),
      ).toBe(identity === undefined);
    }
  });

  it("renders the durable session actor avatar with the header attribution semantics", async () => {
    const mounted = mountHeader({
      showOwnerChip: true,
      session: row({
        createdActor: {
          type: "human",
          id: "profile-ada",
          label: "Ada",
          avatarUrl: "/api/users/profile-ada/avatar?v=7",
        },
        owner: {
          actor: {
            type: "human",
            id: "profile-ada",
            label: "Ada",
            avatarUrl: "/api/users/profile-ada/avatar?v=7",
          },
        },
      }),
    });

    await vi.waitFor(() => {
      expect(mounted.container.querySelector("openclaw-session-owner-chip img")).not.toBeNull();
    });
    const chip = mounted.container.querySelector(".session-owner-chip--header");
    expect(chip?.getAttribute("aria-label")).toBe("Created by Ada");
    expect(chip?.getAttribute("title")).toBe("Created by Ada");
  });

  it.each([
    ["Enter", false, 0, "commit"],
    ["Escape", false, 0, "cancel"],
    ["Enter", true, 0, null],
    ["Enter", false, 229, null],
  ] as const)(
    "routes rename %s with isComposing=%s and keyCode=%i",
    (key, isComposing, keyCode, action) => {
      const { container, props } = mountHeader({ editing: true, renameValue: "研究" });
      const input = container.querySelector<HTMLInputElement>(".chat-pane__session-title-input");
      expect(input).toBeInstanceOf(HTMLInputElement);
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
        isComposing,
        keyCode,
      });
      input?.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(action !== null);
      expect(props.onCommitRename).toHaveBeenCalledTimes(action === "commit" ? 1 : 0);
      expect(props.onCancelRename).toHaveBeenCalledTimes(action === "cancel" ? 1 : 0);
    },
  );

  it.each(["keyup", "timeout"])(
    "keeps a Safari composition-confirm Enter from committing a session rename until %s",
    (release) => {
      const { container, props } = mountHeader({ editing: true, renameValue: "日本語" });
      const input = container.querySelector<HTMLInputElement>(".chat-pane__session-title-input")!;
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const end = new CompositionEvent("compositionend", { bubbles: true, data: "日本語" });
      input.dispatchEvent(end);
      for (const offset of [1, 100]) {
        const enter = new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(enter, "timeStamp", {
          value: end.timeStamp + (release === "timeout" ? offset : 1),
        });
        if (offset === 100 && release === "keyup") {
          input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter" }));
        }
        input.dispatchEvent(enter);
        expect(enter.defaultPrevented).toBe(offset === 100);
        expect(props.onCommitRename).toHaveBeenCalledTimes(offset === 100 ? 1 : 0);
        expect(props.onCancelRename).not.toHaveBeenCalled();
        expect(input.value).toBe("日本語");
      }
    },
  );

  it("keeps catalog sessions static and without a workspace chip", () => {
    const { container } = mountHeader({
      catalog: true,
      session: undefined,
      panelMenuActions: [{ id: "terminal", label: "Terminal", icon: html``, onActivate: vi.fn() }],
    });
    expect(container.querySelector(".chat-pane__session-title-button")).toBeNull();
    expect(container.querySelector(".chat-pane__session-title")?.textContent).toContain(
      "Session title",
    );
    expect(container.querySelector(".chat-pane__workspace-chip")).toBeNull();
    expect(container.querySelector('.chat-pane__layout-menu [value="terminal"]')).not.toBeNull();
  });

  it("keeps read-only gateway session titles static", () => {
    const { container } = mountHeader({
      renameDisabledReason: "Operator write access is required.",
    });
    expect(container.querySelector(".chat-pane__session-title-button")).toBeNull();
    expect(container.querySelector(".chat-pane__session-title")?.textContent).toContain(
      "Session title",
    );
    expect(container.querySelector(".chat-pane__session-title")?.getAttribute("title")).toBe(
      "Operator write access is required.",
    );
  });

  it("shows copied feedback on the workspace chip", () => {
    const { container } = mountHeader({ copiedAction: "copy-path" });
    expect(container.querySelector(".chat-pane__workspace-chip")?.textContent).toContain("Copied");
  });

  it("shows cloud placement and hides reveal when disabled", () => {
    const session = row({ placement: { state: "active" } as GatewaySessionRow["placement"] });
    const { container } = mountHeader({
      session,
      placementControl: renderChatPanePlacement({ session }),
      canReveal: false,
    });
    expect(container.querySelector(".chat-pane__placement-chip")).not.toBeNull();
    expect(container.querySelector('wa-dropdown-item[value="reveal"]')).toBeNull();
    expect(container.querySelector('wa-dropdown-item[value="copy-path"]')).not.toBeNull();
  });

  it("shows an incognito indicator for in-memory threads", () => {
    const { container } = mountHeader({ session: row({ incognito: true }) });
    expect(container.querySelector(".chat-pane__incognito")?.getAttribute("aria-label")).toBe(
      "Incognito session",
    );
  });

  it("hides one branch and lists multiple branches with the active tip marked", async () => {
    const one = mountHeader({
      branches: [{ leafEntryId: "only", headline: "Only path", messageCount: 1, active: true }],
    });
    await one.container.querySelector("openclaw-chat-pane-versions-menu")?.updateComplete;
    expect(one.container.querySelector(".chat-pane__branches-trigger")).toBeNull();

    const multiple = mountHeader({
      branches: [
        { leafEntryId: "active", headline: "Current work", messageCount: 4, active: true },
        {
          leafEntryId: "other",
          headline: "Earlier idea",
          messageCount: 2,
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
          active: false,
        },
      ],
    });
    await multiple.container.querySelector("openclaw-chat-pane-versions-menu")?.updateComplete;
    const menu = multiple.container.querySelector(".chat-pane__branches-menu");
    const items = multiple.container.querySelectorAll(".chat-pane__branch-item");
    // wa-popup anchors to the first slot="trigger" element; a display:contents
    // wrapper (like openclaw-tooltip) has a zero rect and pins the menu to the
    // window's top-left corner, so the slotted trigger must be the button itself.
    const trigger = menu?.querySelector('[slot="trigger"]');
    expect(trigger?.classList.contains("chat-pane__branches-trigger")).toBe(true);
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Current work");
    expect(items[0]?.getAttribute("data-active")).toBe("true");
    expect(items[0]?.querySelector(".chat-pane__branch-active")).not.toBeNull();
    expect(items[1]?.textContent).toContain("Earlier idea");

    menu?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "other" } },
      }),
    );
    expect(multiple.props.onBranchSelect).toHaveBeenCalledWith("other");
  });

  it("disables branch switching while the agent is working", async () => {
    const { container, props } = mountHeader({
      branchSwitchDisabledReason: "Branch switch is unavailable while the agent is working.",
      branches: [
        { leafEntryId: "active", headline: "Current work", messageCount: 4, active: true },
        { leafEntryId: "other", headline: "Earlier idea", messageCount: 2, active: false },
      ],
    });
    await container.querySelector("openclaw-chat-pane-versions-menu")?.updateComplete;
    const trigger = container.querySelector<HTMLButtonElement>(".chat-pane__branches-trigger");
    expect(trigger?.disabled).toBe(true);
    container.querySelector(".chat-pane__branches-menu")?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value: "other" } },
      }),
    );
    expect(props.onBranchSelect).not.toHaveBeenCalled();
  });
});

describe("chat pane parent resolution", () => {
  it("omits unresolved and self-referential parents", () => {
    const child = row({ key: "agent:main:child", parentSessionKey: "agent:main:missing" });
    expect(resolveChatPaneParentSession(child, [child])).toBeNull();
    expect(
      resolveChatPaneParentSession({ ...child, parentSessionKey: child.key }, [child]),
    ).toBeNull();
  });
});

describe("chat pane workspace resolution", () => {
  it("uses worktree repo vocabulary with spawned cwd", () => {
    expect(
      resolveSessionWorkspace({
        session: row({
          spawnedCwd: "/tmp/worktrees/title-bar",
          worktree: { id: "wt-1", branch: "title-bar", repoRoot: "/src/openclaw" },
        }),
      }),
    ).toEqual({ root: "/tmp/worktrees/title-bar", label: "openclaw" });
  });

  it("does not substitute the agent workspace for a missing worktree checkout", () => {
    expect(
      resolveSessionWorkspace({
        session: row({
          worktree: { id: "wt-missing", branch: "feature", repoRoot: "/src/openclaw" },
        }),
        agentWorkspace: "/src/default-agent-workspace",
        worktreePath: null,
      }),
    ).toEqual({ root: null, label: "openclaw" });
  });

  it("matches the gateway root order: spawned workspace before spawned cwd", () => {
    expect(
      resolveSessionWorkspace({
        session: row({
          spawnedWorkspaceDir: "/src/openclaw",
          spawnedCwd: "/src/openclaw/packages/nested",
        }),
      }),
    ).toEqual({ root: "/src/openclaw", label: "openclaw" });
    // execCwd is exec-node routing state; it never overrides local facts.
    expect(
      resolveSessionWorkspace({
        session: row({ execCwd: "/remote/stale", spawnedCwd: "/src/openclaw" }),
      }),
    ).toEqual({ root: "/src/openclaw", label: "openclaw" });
  });

  it("prefers exec cwd and falls back to the agent workspace", () => {
    expect(
      resolveSessionWorkspace({
        session: row({ execNode: "build-mac", execCwd: "/remote/build" }),
        agentWorkspace: "/local/default",
      }),
    ).toEqual({ root: "/remote/build", label: "build" });
    // Without execCwd, gateway-local facts must not stand in for a path that
    // lives on another machine.
    expect(
      resolveSessionWorkspace({
        session: row({ execNode: "build-mac", spawnedCwd: "/local/spawned" }),
        agentWorkspace: "/local/default",
        worktreePath: "/local/worktree",
      }),
    ).toEqual({ root: null, label: null });
    expect(resolveSessionWorkspace({ session: row(), agentWorkspace: "/src/openclaw" })).toEqual({
      root: "/src/openclaw",
      label: "openclaw",
    });
  });

  it("disables reveal for exec nodes, remote placement, and missing advertisement", () => {
    expect(
      canRevealSessionWorkspace({
        session: row({ execNode: "build-mac", execCwd: "/remote/build" }),
        workspaceRoot: "/remote/build",
        methodAdvertised: true,
        hasAdminAccess: true,
      }),
    ).toBe(false);
    expect(
      canRevealSessionWorkspace({
        session: row({ placement: { state: "requested" } as GatewaySessionRow["placement"] }),
        workspaceRoot: "/cloud/work",
        methodAdvertised: true,
        hasAdminAccess: true,
      }),
    ).toBe(false);
    expect(
      canRevealSessionWorkspace({
        session: row(),
        workspaceRoot: "/src/openclaw",
        methodAdvertised: false,
        hasAdminAccess: true,
      }),
    ).toBe(false);
    expect(
      canRevealSessionWorkspace({
        session: row(),
        workspaceRoot: "/src/openclaw",
        methodAdvertised: true,
        hasAdminAccess: false,
      }),
    ).toBe(false);
  });
});

describe("chat pane workspace chip icon", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    containers.splice(0).forEach((container) => container.remove());
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });
  async function mountChip(workspaceIcon: ChatPaneHeaderProps["workspaceIcon"]) {
    const { container } = mountHeader({ workspaceIcon });
    const element = container.querySelector("openclaw-workspace-icon") as
      | (HTMLElement & { updateComplete: Promise<unknown>; requestUpdate(): void })
      | null;
    await element?.updateComplete;
    return { container, element };
  }

  it("keeps the folder glyph when the gateway resolved no project icon", async () => {
    const { container, element } = await mountChip(null);
    expect(element).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();
  });

  it("keeps the folder glyph while credentials are not ready", async () => {
    const fetchSpy = mockWorkspaceIconFetch();
    const { container, element } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: [],
      authReady: false,
    });
    expect(element).not.toBeNull();
    expect(container.querySelector(".workspace-icon")).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("releases a queued icon render on disconnect and recovers on reconnect", async () => {
    const fetchSpy = mockWorkspaceIconFetch().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after": "1" }),
    } as Response);
    const { container, element } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Adisconnected",
      authTokens: ["token"],
      authReady: true,
    });
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledOnce();
    element?.requestUpdate();
    container.remove();
    await element?.updateComplete;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "/__openclaw__/workspace-icon/agent%3Amain%3Adisconnected",
    ]);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

    fetchSpy.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["icon"], { type: "image/png" }),
    } as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:reconnected-workspace-icon");
    document.body.append(container);
    await element?.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    await element?.updateComplete;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLImageElement>(".workspace-icon")?.src).toBe(
      "blob:reconnected-workspace-icon",
    );
  });

  it("recovers when a pending 503 settles between disconnect and immediate reconnect", async () => {
    const pending = createDeferred<Response>();
    const routeUrl = "/__openclaw__/workspace-icon/agent%3Amain%3Aimmediate-reconnect";
    const fetchSpy = mockWorkspaceIconFetch()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        ok: true,
        blob: async () => new Blob(["icon"], { type: "image/png" }),
      } as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:immediate-reconnect");
    const { container, element } = await mountChip({
      routeUrl,
      authTokens: ["token"],
      authReady: true,
    });
    container.remove();
    pending.resolve({
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after": "1" }),
    } as Response);
    await pending.promise;

    // Reattach in this task, before the deferred DOM-handoff release can delete the entry.
    document.body.append(container);
    await element?.updateComplete;
    await vi.advanceTimersByTimeAsync(1_000);
    await element?.updateComplete;

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([routeUrl, routeUrl]);
    expect(container.querySelector<HTMLImageElement>(".workspace-icon")?.src).toBe(
      "blob:immediate-reconnect",
    );
  });

  it("recovers the workspace icon after a transient 503 without remounting", async () => {
    // A previous header can disconnect with a Lit render still queued. Its
    // released retry must not consume the replacement header's response.
    mockWorkspaceIconFetch().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after": "1" }),
    } as Response);
    const previous = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aprevious",
      authTokens: ["token"],
      authReady: true,
    });
    previous.element?.requestUpdate();
    previous.container.remove();
    await previous.element?.updateComplete;
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const fetchSpy = mockWorkspaceIconFetch()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers({ "retry-after": "1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        blob: async () => png,
      } as unknown as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recovered-workspace-icon");
    const { container, element } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Arecovering",
      authTokens: ["token"],
      authReady: true,
    });
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(container.querySelector(".workspace-icon")).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    await element?.updateComplete;

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "/__openclaw__/workspace-icon/agent%3Amain%3Arecovering",
      "/__openclaw__/workspace-icon/agent%3Amain%3Arecovering",
    ]);
    expect(container.querySelector("openclaw-workspace-icon")).toBe(element);
    expect(container.querySelector<HTMLImageElement>(".workspace-icon")?.src).toBe(
      "blob:recovered-workspace-icon",
    );
  });

  it("does not refetch a missing project icon when the header rerenders", async () => {
    const fetchSpy = mockWorkspaceIconFetch().mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);
    const workspaceIcon = {
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: ["token"],
      authReady: true,
    };
    const mounted = mountHeader({ workspaceIcon });
    const element = mounted.container.querySelector("openclaw-workspace-icon") as
      | (HTMLElement & { updateComplete?: Promise<unknown> })
      | null;

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await element?.updateComplete;
    render(
      html`${renderChatPaneHeader({ ...mounted.props, title: "Updated title", workspaceIcon })}`,
      mounted.container,
    );
    await element?.updateComplete;
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    render(
      html`${renderChatPaneHeader({
        ...mounted.props,
        workspaceIcon: { ...workspaceIcon, authTokens: ["new-token"] },
      })}`,
      mounted.container,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("recovers an exhausted mounted icon after a new Gateway connection, not a header render", async () => {
    const fetchSpy = mockWorkspaceIconFetch().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after": "1" }),
    } as Response);
    const context = createSessionContext(createTestGatewayClient(async () => ({})));
    const initial = context.gateway.snapshot;
    if (!initial.hello) {
      throw new Error("expected a connected Gateway fixture");
    }
    context.publishGatewaySnapshot({
      ...initial,
      hello: { ...initial.hello, server: { connId: "initial-connection" } },
    });
    const iconProps = () => resolveChatPaneWorkspaceIcon(context, "agent:main:connection");
    const mounted = mountHeader({ workspaceIcon: null });
    // Use one Lit template callsite for initial mount and subsequent renders so
    // this proves recovery of the same element, not a template replacement.
    const paint = async () => {
      render(
        html`${renderChatPaneHeader({ ...mounted.props, workspaceIcon: iconProps() })}`,
        mounted.container,
      );
      const icon = mounted.container.querySelector<
        HTMLElement & { updateComplete: Promise<unknown> }
      >("openclaw-workspace-icon");
      if (!icon) {
        throw new Error("expected a mounted workspace icon");
      }
      await icon.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      await icon.updateComplete;
      return icon;
    };
    const element = await paint();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    const unchanged = context.gateway.snapshot;
    if (!unchanged.hello) {
      throw new Error("expected a connected Gateway fixture");
    }
    context.publishGatewaySnapshot({
      ...unchanged,
      hello: { ...unchanged.hello, server: { ...unchanged.hello.server } },
    });
    await paint();
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(mounted.container.querySelector(".workspace-icon")).toBeNull();

    fetchSpy.mockResolvedValue({ ok: true, blob: async () => new Blob(["icon"]) } as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:new-gateway-connection");
    const snapshot = context.gateway.snapshot;
    const hello = snapshot.hello;
    if (!hello) {
      throw new Error("expected a connected Gateway fixture");
    }
    context.publishGatewaySnapshot({
      ...snapshot,
      hello: { ...hello, server: { ...hello.server, connId: "new-connection" } },
    });
    await paint();
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(mounted.container.querySelector("openclaw-workspace-icon")).toBe(element);
    expect(mounted.container.querySelector<HTMLImageElement>(".workspace-icon")?.src).toBe(
      "blob:new-gateway-connection",
    );
  });
});
