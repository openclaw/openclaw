/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { PresenceEntry, SessionsListResult } from "../../../api/types.ts";
import { NAV_DRAWER_TOGGLE_REGISTRATION } from "../../../app/navigation-surface.ts";
import { RouteElements, type RouteElementEvent } from "../../../app/route-elements.ts";
import { SHELL_NAV_DRAWER_TOGGLE_EVENT } from "../../../components/command-palette-contract.ts";
import { KEYBOARD_SHORTCUT_COMBOS } from "../../../lib/keyboard-shortcut-contract.ts";
import { allMutationObserverOptions } from "../../../test-helpers/dom-probe.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createChatMobileHostFixture } from "../chat-mobile-host.test-support.ts";
import type { ChatMobileHost } from "../chat-mobile-host.ts";
import {
  activePlacementSession,
  createPaneHeaderWorkspaceFixture,
  createTestChatPane,
} from "../chat-pane.test-support.ts";
import { createSessionCapabilityFixture } from "../chat-session-capability.test-support.ts";
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

const actor = {
  type: "human",
  id: "profile-ada",
  label: "Ada",
  identity: { type: "profile", id: "profile-ada" },
} as const;
const viewer = (id: string, name = id): PresenceEntry => ({
  instanceId: `${id}-instance`,
  ts: 1,
  user: { id, identity: { type: "profile", id }, name },
  watchedSessions: ["agent:main:current"],
});
const query = (
  root: ParentNode,
  selector: string,
): HTMLElement & { updateComplete?: Promise<unknown> } =>
  root.querySelector<HTMLElement>(selector)!;
const text = (root: ParentNode, selector: string) => query(root, selector)?.textContent?.trim();
const absent = (root: ParentNode, selectors: string) =>
  expect(root.querySelector(selectors)).toBeNull();
const keyEvent = (key: string, options: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...options });

function trackNavigation() {
  const elements = new RouteElements();
  const register = (event: Event) => elements.register(event as RouteElementEvent);
  document.addEventListener("openclaw-route-element", register);
  onTestFinished(() => document.removeEventListener("openclaw-route-element", register));
  return () => elements.renderedElements(NAV_DRAWER_TOGGLE_REGISTRATION);
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
  const workspace = createPaneHeaderWorkspaceFixture(state);
  const renderHeader = () =>
    renderPaneHeaderInto(
      pane.renderPaneHeader(workspace, session, false, undefined, false, null),
      container,
    );
  renderHeader();
  return { container, pane, renderHeader };
}

describe("chat pane header", () => {
  it("preserves the merged navigation toggle for catalog sessions", () => {
    const onDrawer = vi.fn<(event: Event) => void>();
    window.addEventListener(SHELL_NAV_DRAWER_TOGGLE_EVENT, onDrawer);
    const { container } = mountHeader({ mergedChrome: true, catalog: true, session: undefined });
    const drawer = container.querySelector<HTMLButtonElement>('[aria-label="Expand sidebar"]')!;
    drawer.click();
    expect(onDrawer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ detail: { trigger: drawer } }),
    );
    window.removeEventListener(SHELL_NAV_DRAWER_TOGGLE_EVENT, onDrawer);
  });

  it("omits shell chrome actions when the header is not merged", () => {
    const { container } = mountHeader();
    expect(container.querySelector(".chat-pane__nav-toggle")).toBeNull();
    expect(container.querySelector(".chat-pane__palette-open")).toBeNull();
  });

  it.each(["openclaw", null])(
    "preserves workspace identity alongside mobile connection status for %s",
    (workspaceLabel) => {
      const retry = vi.fn();
      const { container, update } = mountHeader({ mergedChrome: true, workspaceLabel });
      const title = container.querySelector(".chat-pane__session-title");
      const workspace = container.querySelector(".chat-pane__workspace-chip");
      const drawer = container.querySelector<HTMLButtonElement>(".chat-pane__nav-toggle")!;
      update({ gatewayStatus: { kind: "offline", queuedCount: 2, onRetry: retry } });
      const line = query(container, ".mobile-connection-status");
      expect(line.textContent).toBe("Disconnected · 2 queued");
      expect(line.querySelector('[role="status"]')).toBeNull();
      expect(container.querySelector(".chat-pane__workspace-chip")).toBe(workspace);
      expect(container.querySelector(".chat-pane__session-title")).toBe(title);
      expect(drawer.dataset.connectionStatus).toBe("offline");
      line.querySelector<HTMLButtonElement>("button")!.click();
      expect(retry).toHaveBeenCalledOnce();
      update({ gatewayStatus: { kind: "connected" } });
      expect(container.querySelector(".mobile-connection-status")).toBeNull();
      expect(Boolean(query(container, ".chat-pane__workspace-chip"))).toBe(Boolean(workspaceLabel));
      expect(drawer.dataset.connectionStatus).toBe("connected");
      if (!workspaceLabel) {
        absent(container, ".chat-pane__crumb-sep");
      }
    },
  );

  it("routes desktop split and pane closure through session actions without a Layout rail", async () => {
    const onClosePane = vi.fn();
    const onSplitDown = vi.fn();
    const onOpenSplitView = vi.fn();
    const sessionMenuAction = chatPaneHeaderSessionMenu();
    const { container, update } = mountHeader({
      onClosePane,
      onSplitDown,
      onOpenSplitView,
      sessionMenuAction: {
        ...sessionMenuAction,
        compact: true,
        splitAllowed: true,
        session: { ...sessionMenuAction.session, target: { key: "agent:main:test" } },
      },
    });
    const close = container.querySelector<HTMLButtonElement>(".chat-pane__close")!;
    const menu = container.querySelector("openclaw-chat-header-session-menu")!;
    await menu.updateComplete;
    absent(container, ".chat-pane__layout-menu");
    await selectNativeMenu(menu, "quick:open-split-view");
    expect(onOpenSplitView).toHaveBeenCalledExactlyOnceWith();
    await selectNativeMenu(menu, "compact:open-view");
    expect(menu.querySelector('[data-value="layout:side-panel"]')).toBeNull();
    await selectNativeMenu(menu, "layout:close-pane");
    expect(onClosePane).toHaveBeenCalledExactlyOnceWith("pane-1");
    await selectNativeMenu(menu, "compact:open-advanced");
    await selectNativeMenu(menu, "compact:open-open-in");
    await selectNativeMenu(menu, "split-below");
    expect(onSplitDown).toHaveBeenCalledExactlyOnceWith("pane-1");
    update({ actionsDisabled: true });
    expect(close.disabled).toBe(true);
    close.click();
    expect(onClosePane).toHaveBeenCalledOnce();
    await openNativeMenu(menu);
    const split = menu.querySelector<HTMLButtonElement>('[data-value="quick:open-split-view"]')!;
    expect(split.disabled).toBe(true);
    split.click();
    expect(onOpenSplitView).toHaveBeenCalledOnce();
    update({ onClosePane: undefined });
    expect(container.querySelector(".chat-pane__close")).toBeNull();
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
    update({ mergedChrome: false, catalog: true, session: undefined });
    container.querySelector<HTMLButtonElement>(".chat-pane__panels-toggle")!.click();
    expect(onToggleSidePanel).toHaveBeenCalledTimes(2);
  });

  it("keeps desktop session actions beside native connection status and Retry", () => {
    const onRetry = vi.fn();
    const { container, update } = mountHeader({ sessionMenuAction: chatPaneHeaderSessionMenu() });
    expect(container.querySelector("openclaw-chat-header-session-menu")).not.toBeNull();
    update({ gatewayStatus: { kind: "offline", onRetry } });
    expect(container.querySelector("openclaw-chat-header-session-menu")).not.toBeNull();
    expect(text(container, '[role="status"]')).toContain("Disconnected");
    container.querySelector<HTMLButtonElement>(".chat-pane__connection-retry")!.click();
    expect(onRetry).toHaveBeenCalledOnce();
    update({ gatewayStatus: { kind: "restoring", onRetry } });
    expect(text(container, '[role="status"]')).toContain("Restoring");
    expect(container.querySelector(".chat-pane__connection-retry")).toBeNull();
    update({ gatewayStatus: { kind: null, onRetry } });
    expect(container.querySelector(".chat-pane__connection")).toBeNull();
    expect(container.querySelector("openclaw-chat-header-session-menu")).not.toBeNull();
  });

  it("translates the saved-conversation status through the header's English catalog registration", () => {
    const { container, update } = mountHeader({
      savedConversation: true,
      gatewayStatus: { kind: "reconnecting" },
    });
    const savedStatus = () => text(container, ".chat-pane__connection-state");
    expect(savedStatus()).toBe("Saved conversation · Reconnecting…");
    update({ gatewayStatus: undefined });
    absent(container, ".chat-pane__connection");
    update({ gatewayStatus: { kind: "offline" } });
    expect(savedStatus()).toBe("Saved conversation · Disconnected");
    update({ savedConversation: false, gatewayStatus: { kind: null } });
    absent(container, ".chat-pane__connection");
  });

  it("defers narrow Layout shortcuts and retains their nodes across label updates", async () => {
    const readShortcut = vi.fn(() => KEYBOARD_SHORTCUT_COMBOS.terminalPanel);
    const action = (label: string) => ({
      id: "terminal",
      label,
      icon: "copy" as const,
      onActivate: vi.fn(),
      get shortcut() {
        return readShortcut();
      },
    });
    const { container, update } = mountHeader({
      narrow: true,
      mergedChrome: true,
      panelMenuActions: [action("Terminal")],
    });
    const menu = container.querySelector(".chat-pane__layout-menu")!;
    expect(readShortcut).not.toHaveBeenCalled();
    await openNativeMenu(menu, "terminal");
    const shortcut = menu.querySelector('[data-value="terminal"] kbd');
    expect(shortcut).not.toBeNull();
    update({ panelMenuActions: [action("Open terminal")] });
    expect(menu.querySelector('[data-value="terminal"] kbd')).toBe(shortcut);
    expect(query(menu, '[data-value="terminal"]').getAttribute("aria-label")).toBe("Open terminal");
  });

  it("shows the muted running count only while there are active subagents", () => {
    const { container, update } = mountHeader({ runningSubagentCount: 2 });
    expect(text(container, ".chat-pane__subagents-running")).toContain("Subagents · 2 running");
    update({ runningSubagentCount: 0 });
    expect(container.querySelector(".chat-pane__subagents-running")).toBeNull();
  });

  it("retains cloud placement, action ownership and control ordering across updates", async () => {
    const onPlacementMove = vi.fn();
    const onPlacementReclaim = vi.fn();
    const session = activePlacementSession();
    const { container, update } = mountHeader({
      placementControl: { session, onPlacementMove, onPlacementReclaim },
      presence: { staticUsers: [], personActivity: undefined },
    });
    const crumbs = query(container, ".chat-pane__crumbs");
    const placement = query(container, ".chat-pane__placement-control");
    expect(crumbs.parentElement).toBe(placement.parentElement);
    expect(crumbs.compareDocumentPosition(placement)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(query(container, ".chat-pane__header-trailing .chat-pane__presence")).not.toBeNull();
    expect(text(container, ".chat-pane__placement-chip")).toBe("Runs on Cloud");
    const menu = container.querySelector(".chat-pane__placement-menu")!;
    await openNativeMenu(menu);
    await selectNativeMenu(menu, "move");
    expect(onPlacementMove).toHaveBeenCalledOnce();
    await selectNativeMenu(menu, "reclaim");
    expect(onPlacementReclaim).toHaveBeenCalledOnce();
    await openNativeMenu(menu);
    const nextMove = vi.fn();
    update({ title: "Updated session", placementControl: { session, onPlacementMove: nextMove } });
    expect(container.querySelector(".chat-pane__placement-menu")).toBe(menu);
    expect(menu.querySelector(".oc-menu")?.matches(":popover-open")).toBe(true);
    await selectNativeMenu(menu, "move");
    expect(onPlacementMove).toHaveBeenCalledOnce();
    expect(nextMove).toHaveBeenCalledOnce();
  });

  it("shows durable move progress in the placement chip", () => {
    const session = row({
      placement: { ...activePlacementSession().placement!, state: "draining" },
      placementMove: {
        target: { kind: "gateway" },
        updatedAtMs: 300_000,
      },
    });
    const { container } = mountHeader({
      session,
      placementControl: { session },
    });

    expect(text(container, ".chat-pane__placement-chip")).toBe("Moving to Gateway…");
  });

  it("keeps the public indicator visible in narrow headers", () => {
    const { container } = mountHeader({
      narrow: true,
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

    const indicator = container.querySelector(".chat-pane__public-share-indicator")!;
    expect(indicator.getAttribute("aria-label")).toBe(
      "Public — anyone can read without signing in.",
    );
    expect(indicator.querySelector("svg")).not.toBeNull();
    expect(indicator.textContent).toBe("");
  });

  it("replaces the header owner avatar when visibility is available", () => {
    const { container } = mountHeader({
      session: row({ owner: { actor } }),
      showOwnerChip: true,
      sharingControl: chatPaneHeaderSharing(),
    });

    expect(container.querySelector("openclaw-session-owner-chip")).toBeNull();
    expect(query(container, ".chat-pane__sharing-menu").parentElement?.className).toBe(
      "chat-pane__actions",
    );
  });

  it("renders the bounded static participant facepile beside the owner", async () => {
    const mounted = mountHeader({
      showOwnerChip: true,
      session: row({
        createdActor: actor,
        owner: { actor },
        participants: [
          { identity: { type: "profile", id: "profile-bob" }, label: "Bob" },
          { identity: { type: "agent", id: "research" }, label: "Research" },
        ],
        participantCount: 2,
      }),
    });
    const facepile = query(mounted.container, "openclaw-viewer-facepile.chat-pane__participants");
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
    expect(facepile.querySelector("[data-viewer-id]")).toBeNull();
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
    const presence = [viewer("guest", "Guest")];
    const mounted = mountIntegratedPresenceHeader({ owners: [], presence });
    const facepile = mounted.container.querySelector("openclaw-viewer-facepile")!;
    await facepile.updateComplete;
    const updates: MutationRecord[] = [];
    const observer = new MutationObserver((records) => updates.push(...records));
    observer.observe(facepile, allMutationObserverOptions());
    onTestFinished(() => observer.disconnect());
    mounted.renderHeader();
    await facepile.updateComplete;
    expect(updates).toHaveLength(0);
    mounted.pane.presence.update({
      presence: [...presence, viewer("second", "Second")],
    });
    mounted.renderHeader();
    await facepile.updateComplete;
    expect(updates.length).toBeGreaterThan(0);
    expect(facepile.querySelectorAll("openclaw-viewer-avatar")).toHaveLength(2);
  });

  it("updates the header owner vitality from live session presence", async () => {
    const owners = [actor, { type: "human" as const, id: "profile-zoe", label: "Zoe" }];
    const guest = viewer("profile-zoe", "Zoe");
    const mounted = mountIntegratedPresenceHeader({ owners, presence: [guest] });
    const ownerChip = query(mounted.container, "openclaw-session-owner-chip");

    await ownerChip?.updateComplete;
    for (const identity of [undefined, { type: "profile" as const, id: "profile-ada" }]) {
      mounted.pane.presence.update({
        presence: [
          { ...viewer("profile-ada", "Ada"), user: { id: "profile-ada", identity, name: "Ada" } },
          guest,
        ],
      });
      mounted.renderHeader();
      await ownerChip?.updateComplete;
      expect(
        query(mounted.container, ".session-owner-chip--header").classList.contains(
          "session-owner-chip--away",
        ),
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
        renameValue: "Renaming",
        renameDisabledReason: action === "blocked" ? "Session access was revoked" : undefined,
      });
      const input = container.querySelector<HTMLInputElement>(".chat-pane__session-title-input")!;
      const event = keyEvent(key, { isComposing, keyCode });
      input.dispatchEvent(event);
      if (key === "Enter" && action !== null) {
        input.dispatchEvent(new FocusEvent("blur"));
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
        const enter = keyEvent("Enter", { keyCode: 13 });
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

  it.each([
    { catalog: true, session: undefined },
    { renameDisabledReason: "Operator write access is required." },
  ])("keeps catalog and read-only session titles static: %j", (options) => {
    const { container } = mountHeader(options);
    absent(container, ".chat-pane__session-title-button");
    expect(text(container, ".chat-pane__session-title")).toContain("Session title");
    expect(query(container, ".chat-pane__session-title").title).toBe(
      options.renameDisabledReason ?? "Session title",
    );
    if (options.catalog) {
      absent(container, ".chat-pane__workspace-chip, .chat-pane__layout-menu");
    }
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
          expect(text(container, ".chat-pane__workspace-chip")).toContain("Copied");
          update({ copiedAction: null });
        }
      }
      expect(props.onMenuAction).toHaveBeenCalledTimes(3);
      update({ canReveal: false, branch: null });
      await openNativeMenu(menu);
      absent(menu, '[data-value="reveal"], [data-value="copy-branch"], [role="separator"]');
      expect(menu.querySelector('[data-value="copy-path"]')).not.toBeNull();
    },
  );

  it("names incognito threads and supplies their lifetime to the accessible reveal tooltip", async () => {
    const { container } = mountHeader({ session: row({ incognito: true }) });
    const indicator = container.querySelector<HTMLButtonElement>("button.chat-pane__incognito")!;
    const tooltip = indicator.closest("openclaw-tooltip")!;
    await tooltip.updateComplete;
    expect(indicator?.textContent).toContain("Incognito");
    expect(tooltip.content).toBe(
      "Incognito session. History expires 24 hours after creation or when the Gateway restarts, whichever comes first.",
    );
    expect(tooltip.openOnClick).toBe(true);
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

it("publishes the active header while retaining mobile chrome across desktop transitions", async () => {
  const registered = trackNavigation();
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
  const mobileHeader = query(mounted.container, ".agent-chat__header--mobile");
  const toggle = query(mobileHeader, ".mobile-header__navigation");
  for (let transition = 0; transition < 2; transition += 1) {
    await waitForSolid(() =>
      expect(pane.headerElement).toBe(mounted.container.querySelector(".chat-pane__header")),
    );
    expect(pane.headerElement).not.toBeNull();
    mounted.update({ mergedChrome: true });
    await waitForSolid(() => expect(pane.headerElement).toBe(mobileHeader));
    expect(registered()).toEqual([toggle]);
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
    expect(registered()).toEqual([]);
  } finally {
    toggle.remove();
  }
});
