/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { GatewaySessionRow, PresenceEntry, SessionsListResult } from "../../../api/types.ts";
import { NAV_DRAWER_TOGGLE_REGISTRATION } from "../../../app/navigation-surface.ts";
import { RouteElements, type RouteElementEvent } from "../../../app/route-elements.ts";
import {
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type ShellNavDrawerToggleDetail,
} from "../../../components/command-palette-contract.ts";
import { KEYBOARD_SHORTCUT_COMBOS } from "../../../lib/keyboard-shortcut-contract.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createChatMobileHostFixture } from "../chat-mobile-host.test-support.ts";
import type { ChatMobileHost } from "../chat-mobile-host.ts";
import {
  activePlacementSession,
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "../chat-pane.test-support.ts";
import type { ChatPageHost } from "../chat-state-host.ts";
import { openSlot } from "../sidebar-layout.ts";
import {
  chatPaneHeaderSessionRow as row,
  chatPaneHeaderSharing,
  chatPaneHeaderSessionMenu,
  mountChatPaneHeader,
  openNativeMenu,
  selectNativeMenu,
  renderPaneHeaderInto,
} from "./chat-pane-header.test-support.ts";
import type { ChatPaneHeaderProps } from "./chat-pane-header.types.ts";

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
  pane.presence.update({ presence: params.presence });
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const renderHeader = () =>
    renderPaneHeaderInto(
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

  it.each(["openclaw", null])(
    "preserves session identity alongside mobile connection status for %s",
    (workspaceLabel) => {
      const retry = vi.fn();
      const { container, update } = mountHeader({ mergedChrome: true, workspaceLabel });
      const title = container.querySelector(".chat-pane__session-title");
      expect(container.querySelector(".chat-pane__workspace-chip") !== null).toBe(
        Boolean(workspaceLabel),
      );
      const drawer = container.querySelector<HTMLButtonElement>(".chat-pane__nav-toggle")!;
      update({ gatewayStatus: { kind: "offline", queuedCount: 2, onRetry: retry } });
      const line = container.querySelector(".mobile-connection-status")!;
      expect(line.textContent).toBe("Disconnected · 2 queued");
      expect(line.querySelector('[role="status"]')).toBeNull();
      expect(container.querySelector(".chat-pane__workspace-chip")).toBeNull();
      expect(container.querySelector(".chat-pane__session-title")).toBe(title);
      expect(drawer.dataset.connectionStatus).toBe("offline");
      line.querySelector<HTMLButtonElement>("button")!.click();
      expect(retry).toHaveBeenCalledOnce();
      update({ gatewayStatus: { kind: "connected" } });
      expect(container.querySelector(".mobile-connection-status")).toBeNull();
      expect(container.querySelector(".chat-pane__workspace-chip") !== null).toBe(
        Boolean(workspaceLabel),
      );
      expect(drawer.dataset.connectionStatus).toBe("connected");
    },
  );

  it("routes desktop split and pane closure through session actions without a Layout rail", async () => {
    const onClosePane = vi.fn();
    const onSplitDown = vi.fn();
    const onSplitRight = vi.fn();
    const onOpenSplitView = vi.fn();
    const sessionMenuAction = chatPaneHeaderSessionMenu();
    const { container, update } = mountHeader({
      onClosePane,
      onSplitDown,
      onSplitRight,
      onOpenSplitView,
      sharingControl: chatPaneHeaderSharing(),
      sessionMenuAction: {
        ...sessionMenuAction,
        compact: true,
        splitAllowed: true,
        session: { ...sessionMenuAction.session, target: { key: "agent:main:test" } },
      },
    });
    const menu = container.querySelector("openclaw-chat-header-session-menu")!;
    await menu.updateComplete;
    expect(container.querySelector(".chat-pane__layout-menu")).toBeNull();
    expect(container.querySelector(".chat-pane__sharing-trigger")).not.toBeNull();
    expect(
      container.querySelector(".chat-pane__identity-actions .chat-header-session-menu__trigger"),
    ).not.toBeNull();
    await selectNativeMenu(menu, "quick:open-split-view");
    expect(onOpenSplitView).toHaveBeenCalledExactlyOnceWith();
    await selectNativeMenu(menu, "compact:open-view");
    expect(menu.querySelector('[data-value="layout:side-panel"]')).toBeNull();
    await selectNativeMenu(menu, "layout:close-pane");
    expect(onClosePane).toHaveBeenCalledExactlyOnceWith("pane-1");
    for (const [value, callback] of [
      ["split-right", onSplitRight],
      ["split-below", onSplitDown],
    ] as const) {
      await selectNativeMenu(menu, "compact:open-advanced");
      await selectNativeMenu(menu, "compact:open-open-in");
      await selectNativeMenu(menu, value);
      expect(callback).toHaveBeenCalledExactlyOnceWith("pane-1");
    }
    update({ actionsDisabled: true });
    await openNativeMenu(menu);
    const split = menu.querySelector<HTMLButtonElement>('[data-value="quick:open-split-view"]')!;
    expect(split.disabled).toBe(true);
    split.click();
    expect(onOpenSplitView).toHaveBeenCalledOnce();
    update({ onClosePane: undefined });
    await selectNativeMenu(menu, "compact:open-view");
    expect(menu.querySelector('[data-value="layout:close-pane"]')).toBeNull();
  });

  it("toggles Panels through the native owner and reflects its current layout", () => {
    const onToggleSidePanel = vi.fn();
    const { container, update } = mountHeader({
      onToggleSidePanel,
      sidebarLayout: { columns: [], open: false },
    });
    const toggle = container.querySelector<HTMLButtonElement>(".chat-pane__panels-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    expect(onToggleSidePanel).toHaveBeenCalledOnce();
    update({ sidebarLayout: openSlot({ columns: [] }, "detail") });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    update({ mergedChrome: true });
    expect(container.querySelector(".chat-pane__panels-toggle")).toBeNull();
  });

  it("replaces desktop session actions with native connection status and Retry, then restores them", () => {
    const onRetry = vi.fn();
    const { container, update } = mountHeader({ sessionMenuAction: chatPaneHeaderSessionMenu() });
    expect(container.querySelector("openclaw-chat-header-session-menu")).not.toBeNull();
    update({ gatewayStatus: { kind: "offline", onRetry } });
    expect(container.querySelector("openclaw-chat-header-session-menu")).toBeNull();
    expect(container.querySelector("openclaw-chat-pane-versions-menu")).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Disconnected");
    container.querySelector<HTMLButtonElement>(".chat-pane__connection-retry")!.click();
    expect(onRetry).toHaveBeenCalledOnce();
    update({ gatewayStatus: { kind: "restoring", onRetry } });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Restoring");
    expect(container.querySelector(".chat-pane__connection-retry")).toBeNull();
    update({ gatewayStatus: { kind: null, onRetry } });
    expect(container.querySelector(".chat-pane__connection")).toBeNull();
    expect(container.querySelector("openclaw-chat-header-session-menu")).not.toBeNull();
    update({ mergedChrome: true, gatewayStatus: { kind: "offline", onRetry } });
    expect(container.querySelector(".chat-pane__connection")).toBeNull();
    expect(container.querySelector("openclaw-chat-header-session-menu")).toBeNull();
    expect(container.querySelector(".mobile-connection-status")?.textContent).toContain(
      "Disconnected",
    );
  });

  it("keeps available panels in the narrow Layout menu while omitting split actions", async () => {
    const onTerminal = vi.fn();
    const readShortcut = vi.fn(() => KEYBOARD_SHORTCUT_COMBOS.terminalPanel);
    const action = (label: string) => ({
      id: "terminal",
      label,
      icon: "copy" as const,
      onActivate: onTerminal,
      get shortcut() {
        return readShortcut();
      },
    });
    const { container, update } = mountHeader({
      narrow: true,
      mergedChrome: true,
      panelMenuActions: [action("Terminal")],
      sessionMenuAction: chatPaneHeaderSessionMenu(),
      onOpenSplitView: vi.fn(),
      onSplitDown: vi.fn(),
      onSplitRight: vi.fn(),
    });
    const menu = container.querySelector(".chat-pane__layout-menu")!;
    expect(readShortcut).not.toHaveBeenCalled();
    await openNativeMenu(menu);
    const shortcut = menu.querySelector('[data-value="terminal"] kbd');
    expect(shortcut).not.toBeNull();
    update({ panelMenuActions: [action("Open terminal")] });
    expect(menu.querySelector('[data-value="terminal"] kbd')).toBe(shortcut);
    expect(menu.querySelector('[data-value="terminal"]')?.getAttribute("aria-label")).toBe(
      "Open terminal",
    );
    expect(container.querySelector(".chat-pane__split-down")).toBeNull();
    expect(container.querySelector(".chat-pane__split-right")).toBeNull();
    expect(container.querySelector(".chat-pane__nav-toggle")).not.toBeNull();
    await selectNativeMenu(menu, "terminal");
    expect(onTerminal).toHaveBeenCalledOnce();
  });

  it("shows the muted running count only while there are active subagents", () => {
    const { container, update } = mountHeader({ runningSubagentCount: 2 });
    expect(container.querySelector(".chat-pane__subagents-running")?.textContent).toContain(
      "Subagents · 2 running",
    );
    update({ runningSubagentCount: 0 });
    expect(container.querySelector(".chat-pane__subagents-running")).toBeNull();
  });

  it("renders a quiet cloud placement chip with move and stop actions", async () => {
    const onPlacementMove = vi.fn();
    const onPlacementReclaim = vi.fn();
    const { container } = mountHeader({
      placementControl: {
        session: activePlacementSession(),
        onPlacementMove,
        onPlacementReclaim,
      },
    });

    expect(container.querySelector(".chat-pane__placement-chip")?.textContent?.trim()).toBe(
      "Runs on Cloud",
    );
    expect(container.querySelector(".chat-pane__placement-state")).toBeNull();
    expect(container.querySelector(".chat-pane__placement-note")).toBeNull();
    const menu = container.querySelector(".chat-pane__placement-menu")!;
    await openNativeMenu(menu);
    const actions = container.querySelectorAll(".chat-pane__placement-menu [role^=menuitem]");
    expect(actions).toHaveLength(2);
    expect(actions[0]?.textContent?.trim()).toBe("Move session…");
    expect(actions[0]?.classList.contains("session-menu__item--destructive")).toBe(false);
    await selectNativeMenu(menu, "move");
    expect(onPlacementMove).toHaveBeenCalledOnce();
    expect(actions[1]?.textContent?.trim()).toBe("Stop cloud worker…");
    expect(actions[1]?.classList.contains("session-menu__item--destructive")).toBe(true);
    expect(actions[1]?.getAttribute("data-variant")).toBe("danger");
    expect(actions[1]?.querySelector(".session-menu__icon")).not.toBeNull();
    await selectNativeMenu(menu, "reclaim");
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
      placementControl: { session },
    });

    expect(container.querySelector(".chat-pane__placement-chip")?.textContent?.trim()).toBe(
      "Moving to Gateway…",
    );
  });

  it("keeps the placement menu open and its callbacks current across header updates", async () => {
    const session = activePlacementSession();
    const firstMove = vi.fn();
    const nextMove = vi.fn();
    const { container, update } = mountHeader({
      placementControl: { session, onPlacementMove: firstMove },
    });
    const menu = container.querySelector(".chat-pane__placement-menu")!;
    await openNativeMenu(menu);

    update({ title: "Updated session", placementControl: { session, onPlacementMove: nextMove } });

    expect(container.querySelector(".chat-pane__placement-menu")).toBe(menu);
    expect(menu.querySelector(".oc-menu")?.matches(":popover-open")).toBe(true);
    await selectNativeMenu(menu, "move");
    expect(firstMove).not.toHaveBeenCalled();
    expect(nextMove).toHaveBeenCalledOnce();
  });

  it("keeps placement after identity and presence in the right control group", () => {
    const { container } = mountHeader({
      placementControl: { session: activePlacementSession() },
      presence: { staticUsers: [], personActivity: undefined },
    });
    const crumbs = container.querySelector(".chat-pane__crumbs");
    const placement = container.querySelector(".chat-pane__placement-control");
    expect(crumbs?.parentElement).toBe(placement?.parentElement);
    expect(crumbs!.compareDocumentPosition(placement!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      container.querySelector(".chat-pane__header-trailing .chat-pane__presence"),
    ).not.toBeNull();
  });

  it("keeps the public indicator visible in narrow headers", () => {
    const narrow = true;
    const { container } = mountHeader({
      narrow,
      publicAccessIndicator: chatPaneHeaderSharing({
        state: {
          loading: false,
          result: {
            sessionKey: "agent:main:test",
            members: [],
            identities: [],
            role: "owner",
            allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
            publicShare: { token: "synthetic-share", createdAt: 1 },
          },
        },
      }),
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
      sharingControl: chatPaneHeaderSharing(),
    });

    expect(container.querySelector("openclaw-session-owner-chip")).toBeNull();
    expect(container.querySelector(".chat-pane__sharing-menu")?.parentElement?.className).toBe(
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
    await vi.dynamicImportSettled();

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
    mounted.pane.presence.update({
      presence: [
        ...presence,
        {
          instanceId: "second-instance",
          ts: 1,
          user: { id: "second", identity: { type: "profile", id: "second" }, name: "Second" },
          watchedSessions: ["agent:main:current"],
        },
      ],
    });
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
      mounted.pane.presence.update({
        presence: [
          {
            instanceId: "profile-ada-instance",
            ts: 1,
            user: { id: "profile-ada", identity, name: "Ada" },
            watchedSessions: [sessionKey],
          },
          guest,
        ],
      });
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
    ["Enter", false, 0, "blocked"],
  ] as const)(
    "routes offline rename %s with isComposing=%s and keyCode=%i: %s",
    (key, isComposing, keyCode, action) => {
      const { container, props } = mountHeader({
        editing: true,
        actionsDisabled: true,
        renameDisabledReason: action === "blocked" ? "Session access was revoked" : undefined,
      });
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
      if (key === "Enter" && action !== null) {
        input?.dispatchEvent(new FocusEvent("blur"));
      }

      expect(event.defaultPrevented).toBe(action !== null);
      expect(props.onCommitRename).toHaveBeenCalledTimes(action === "commit" ? 2 : 0);
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

  it("keeps catalog identity static while Panels remains available", () => {
    const onToggleSidePanel = vi.fn();
    const { container } = mountHeader({
      onToggleSidePanel,
      catalog: true,
      session: undefined,
      panelMenuActions: [{ id: "terminal", label: "Terminal", icon: "copy", onActivate: vi.fn() }],
    });
    expect(container.querySelector(".chat-pane__session-title-button")).toBeNull();
    expect(container.querySelector(".chat-pane__session-title")?.textContent).toContain(
      "Session title",
    );
    expect(container.querySelector(".chat-pane__workspace-chip")).toBeNull();
    expect(container.querySelector(".chat-pane__layout-menu")).toBeNull();
    const panels = container.querySelector<HTMLButtonElement>(".chat-pane__panels-toggle")!;
    expect(panels.getAttribute("aria-expanded")).toBe("false");
    panels.click();
    expect(onToggleSidePanel).toHaveBeenCalledOnce();
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

  it.each([false, true])(
    "keeps workspace copy actions before Reveal and preserves feedback with mergedChrome=%s",
    async (mergedChrome) => {
      const { container, props, update } = mountHeader({ mergedChrome, narrow: mergedChrome });
      const menu = container.querySelector(".chat-pane__workspace-menu")!;
      await openNativeMenu(menu);
      expect(
        [...menu.querySelectorAll('[role="menuitem"]')].map((item) =>
          item.getAttribute("data-value"),
        ),
      ).toEqual(["copy-path", "copy-branch", "reveal"]);
      for (const action of ["copy-path", "copy-branch", "reveal"] as const) {
        await selectNativeMenu(menu, action);
        expect(props.onMenuAction).toHaveBeenLastCalledWith(action);
        if (action !== "reveal") {
          update({ copiedAction: action });
          expect(container.querySelector(".chat-pane__workspace-chip")?.textContent).toContain(
            "Copied",
          );
          update({ copiedAction: null });
        }
      }
      expect(props.onMenuAction).toHaveBeenCalledTimes(3);
      update({ canReveal: false, branch: null });
      await openNativeMenu(menu);
      expect(menu.querySelector('[data-value="reveal"]')).toBeNull();
      expect(menu.querySelector('[data-value="copy-branch"]')).toBeNull();
      expect(menu.querySelector('[role="separator"]')).toBeNull();
      expect(menu.querySelector('[data-value="copy-path"]')).not.toBeNull();
    },
  );

  it("shows cloud placement and hides reveal when disabled", async () => {
    const session = row({ placement: { state: "active" } as GatewaySessionRow["placement"] });
    const { container } = mountHeader({
      session,
      placementControl: { session },
      canReveal: false,
    });
    expect(container.querySelector(".chat-pane__placement-chip")).not.toBeNull();
    const menu = container.querySelector(".chat-pane__workspace-menu")!;
    await openNativeMenu(menu);
    expect(container.querySelector('[data-value="reveal"]')).toBeNull();
    expect(container.querySelector('[data-value="copy-path"]')).not.toBeNull();
  });

  it("visibly names incognito threads and reveals their lifetime on focus or activation", async () => {
    const { container } = mountHeader({ session: row({ incognito: true }) });
    const indicator = container.querySelector<HTMLButtonElement>("button.chat-pane__incognito")!;
    const tooltip = indicator.closest("openclaw-tooltip")!;
    await tooltip.updateComplete;
    expect(indicator?.textContent).toContain("Incognito");
    expect(tooltip.content).toBe(
      "Incognito session. History expires 24 hours after creation or when the Gateway restarts, whichever comes first.",
    );
    expect(indicator.getAttribute("aria-describedby")).toBeTruthy();
    indicator.focus();
    await tooltip.updateComplete;
    expect(tooltip.hasAttribute("open")).toBe(true);
    indicator.blur();
    await tooltip.updateComplete;
    expect(tooltip.hasAttribute("open")).toBe(false);
    indicator.click();
    expect(tooltip.hasAttribute("open")).toBe(true);
    indicator.click();
    expect(tooltip.hasAttribute("open")).toBe(false);
    expect(mountHeader().container.querySelector(".chat-pane__incognito")).toBeNull();
  });

  it("keeps Incognito identity and limits visible when only the canonical key marks it private", () => {
    const { container } = mountHeader({
      session: row({ key: "agent:main:dashboard:incognito-private" }),
    });
    const notice = container.querySelector(".chat-pane__incognito-notice");
    expect(container.querySelector(".chat-pane__incognito")?.textContent).toContain("Incognito");
    expect(notice?.textContent).toContain("History expires 24 hours after creation");
    expect(notice?.textContent).toContain("Tools, plugins, and uploads may save data.");
    expect(mountHeader().container.querySelector(".chat-pane__incognito-notice")).toBeNull();
  });
});

it("releases each merged-chrome toggle when its header branch closes", async () => {
  const elements = new RouteElements();
  const register = (event: Event) => elements.register(event as RouteElementEvent);
  document.addEventListener("openclaw-route-element", register);
  onTestFinished(() => document.removeEventListener("openclaw-route-element", register));
  const mounted = mountHeader({ mergedChrome: false });
  const retainedToggle = mounted.container.querySelector<HTMLButtonElement>(
    ".mobile-header__navigation",
  )!;
  await waitForSolid(() =>
    expect(elements.renderedElements(NAV_DRAWER_TOGGLE_REGISTRATION)).toEqual([retainedToggle]),
  );
  for (let mount = 0; mount < 2; mount += 1) {
    mounted.update({ mergedChrome: true });
    const toggle = mounted.container.querySelector<HTMLButtonElement>(".chat-pane__nav-toggle")!;
    await waitForSolid(() =>
      expect(elements.renderedElements(NAV_DRAWER_TOGGLE_REGISTRATION)).toEqual([
        retainedToggle,
        toggle,
      ]),
    );
    mounted.update({ mergedChrome: false });
    // A connected retired button exposes a stale map entry instead of letting isConnected mask it.
    mounted.container.append(toggle);
    try {
      await waitForSolid(() =>
        expect(elements.renderedElements(NAV_DRAWER_TOGGLE_REGISTRATION)).toEqual([retainedToggle]),
      );
    } finally {
      toggle.remove();
    }
  }
  mounted.update({ mergedChrome: true });
  const toggle = mounted.container.querySelector<HTMLButtonElement>(".chat-pane__nav-toggle")!;
  await waitForSolid(() =>
    expect(elements.renderedElements(NAV_DRAWER_TOGGLE_REGISTRATION)).toEqual([
      retainedToggle,
      toggle,
    ]),
  );
  mounted.unmount();
  document.body.append(toggle);
  try {
    expect(elements.renderedElements(NAV_DRAWER_TOGGLE_REGISTRATION)).toEqual([]);
  } finally {
    toggle.remove();
  }
});

it("publishes the active header while retaining mobile chrome across desktop transitions", async () => {
  const elements = new RouteElements();
  const register = (event: Event) => elements.register(event as RouteElementEvent);
  document.addEventListener("openclaw-route-element", register);
  onTestFinished(() => document.removeEventListener("openclaw-route-element", register));
  const { pane, state } = createTestChatPane({
    client: createTestGatewayClient(async () => ({})),
  });
  const nativeHeader = pane.renderPaneHeader(
    createPaneHeaderWorkspaceFixture(state),
    row(),
    false,
    undefined,
    false,
    null,
  ).header;
  const mobileHost: ChatMobileHost = createChatMobileHostFixture("header-registration");
  const mounted = mountHeader({
    mergedChrome: false,
    onHeaderRef: nativeHeader.onHeaderRef,
    detailsControl: {
      chat: undefined,
      elements: {},
      mobile: true,
      mobileHost,
      presentation: true,
      setRef: vi.fn(),
    },
  });
  const mobileHeader = mounted.container.querySelector<HTMLElement>(".agent-chat__header--mobile")!;
  const toggle = mobileHeader.querySelector<HTMLButtonElement>(".mobile-header__navigation")!;
  for (let transition = 0; transition < 2; transition += 1) {
    await waitForSolid(() =>
      expect(pane.headerElement).toBe(mounted.container.querySelector(".chat-pane__header")),
    );
    expect(pane.headerElement).not.toBeNull();
    mounted.update({ mergedChrome: true });
    await waitForSolid(() => expect(pane.headerElement).toBe(mobileHeader));
    expect(elements.renderedElements(NAV_DRAWER_TOGGLE_REGISTRATION)).toEqual([toggle]);
    mounted.update({ mergedChrome: false });
    expect(mounted.container.querySelector(".agent-chat__header--mobile")).toBe(mobileHeader);
  }
  await waitForSolid(() =>
    expect(pane.headerElement).toBe(mounted.container.querySelector(".chat-pane__header")),
  );
  expect(pane.headerElement).not.toBeNull();
  mounted.unmount();
  expect(pane.headerElement).toBeNull();
  // Keeping the retired trigger connected must not hide a leaked registration.
  document.body.append(toggle);
  try {
    expect(elements.renderedElements(NAV_DRAWER_TOGGLE_REGISTRATION)).toEqual([]);
  } finally {
    toggle.remove();
  }
});
