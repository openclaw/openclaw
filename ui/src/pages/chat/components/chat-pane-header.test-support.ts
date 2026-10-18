import { createComponent, createSignal, flush, merge } from "solid-js";
import { expect, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { EMPTY_SESSION_MENU_DATA } from "../../../components/session-menu-actions.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  ChatPaneHeader,
  PaneHeaderView,
  type ChatPaneHeaderPresentation,
} from "./chat-pane-header.tsx";
import type { ChatSessionSharingProps } from "./chat-session-sharing.solid.tsx";
import "./chat-header-session-menu.ts";

export type ChatPaneHeaderProps = Parameters<typeof ChatPaneHeader>[0];

export function chatPaneHeaderSessionMenu(): NonNullable<ChatPaneHeaderProps["sessionMenuAction"]> {
  return {
    session: EMPTY_SESSION_MENU_DATA,
    worktreePath: null,
    onboarding: false,
    preferencesBrowserOnly: false,
    compact: false,
    bubbleModeEnabled: false,
    mainKey: "main",
    copyMarkdownAllowed: false,
    splitAllowed: false,
    settings: { chatShowThinking: false, chatShowToolCalls: false },
    sessionActions: [],
    sharing: null,
    groups: [],
    currentOwner: null,
    actionDisabledReasons: {},
    forkDisabled: false,
    forkFromLastCompleted: false,
    archiveAllowed: false,
    archiveShortcut: false,
    deleteAllowed: false,
    onOpen: vi.fn(),
    onOpenCommandPalette: vi.fn(),
    onSettingsChange: vi.fn(),
    onAction: vi.fn(),
  };
}

const mountedHeaders = new WeakMap<HTMLElement, (value: ChatPaneHeaderPresentation) => void>();

export function renderPaneHeaderInto(value: ChatPaneHeaderPresentation, container: HTMLElement) {
  const update = mountedHeaders.get(container);
  if (update) {
    update(value);
    flush();
    return;
  }
  const [current, setCurrent] = createSignal(value);
  const mounted = mountSolid(
    () =>
      createComponent(
        PaneHeaderView,
        merge(() => current()),
      ),
    { container },
  );
  mountedHeaders.set(container, setCurrent);
  onTestFinished(() => {
    mountedHeaders.delete(container);
    mounted.unmount();
  });
}

export function chatPaneHeaderSharing(
  patch: Partial<ChatSessionSharingProps> = {},
): ChatSessionSharingProps {
  return {
    session: chatPaneHeaderSessionRow({ visibility: "shared", sharingRole: "owner" }),
    state: undefined,
    onOpen: vi.fn(),
    onVisibilityChange: vi.fn(),
    onMemberChange: vi.fn(),
    ...patch,
  };
}

async function settleNativeMenu() {
  flush();
  await Promise.resolve();
  flush();
}

export async function openNativeMenu(menu: Element) {
  await settleNativeMenu();
  const panel = menu.querySelector<HTMLElement>(".oc-menu")!;
  if (!panel.matches(":popover-open")) {
    menu.querySelector<HTMLButtonElement>(".oc-menu-trigger")!.click();
    await settleNativeMenu();
  }
  expect(panel.matches(":popover-open")).toBe(true);
}

export async function selectNativeMenu(menu: Element, value: string) {
  await openNativeMenu(menu);
  const item = menu.querySelector<HTMLButtonElement>(`button[data-value="${value}"]`);
  if (!item) {
    throw new Error(`Expected native menu action: ${value}`);
  }
  expect(item.disabled).toBe(false);
  item.click();
  await settleNativeMenu();
}

export function chatPaneHeaderSessionRow(
  patch: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return { key: "agent:main:test", kind: "direct", updatedAt: 0, ...patch };
}

/**
 * Mounts a retained native header with complete props and test-scoped disposal.
 * `containers` lets callers keep their existing DOM cleanup.
 */
export function mountChatPaneHeader(
  containers: HTMLElement[],
  patch: Partial<ChatPaneHeaderProps> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const props: ChatPaneHeaderProps = {
    paneId: "pane-1",
    presented: true,
    narrow: false,
    mergedChrome: false,
    title: "Session title",
    session: chatPaneHeaderSessionRow(),
    catalog: false,
    editing: false,
    renameValue: "Session title",
    workspaceRoot: "/repo/openclaw",
    workspaceLabel: "openclaw",
    workspaceIcon: null,
    parentSession: null,
    branch: "feature/header",
    branches: [],
    branchSwitchDisabledReason: null,
    platform: "darwin",
    canReveal: true,
    copiedAction: null,
    renameDisabledReason: undefined,
    onBeginRename: vi.fn(),
    onRenameInput: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    onMenuOpenChange: vi.fn(),
    onMenuAction: vi.fn(),
    onOpenParentSession: vi.fn(),
    onOpenAgentSettings: vi.fn(),
    onBranchSelect: vi.fn(),
    ...patch,
  };
  const [current, setCurrent] = createSignal(props);
  const mounted = mountSolid(
    () =>
      createComponent(
        ChatPaneHeader,
        merge(() => current()),
      ),
    { container },
  );
  onTestFinished(mounted.unmount);
  return {
    container,
    get props() {
      return current();
    },
    unmount: mounted.unmount,
    update(this: void, changes: Partial<ChatPaneHeaderProps>) {
      setCurrent({ ...current(), ...changes });
      flush();
    },
  };
}

export function mockWorkspaceIconFetch() {
  const workspaceFetch = vi.fn<typeof fetch>();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    // Other header elements fetch assets asynchronously. They must not consume
    // workspace retry responses or count as authenticated icon requests.
    if (typeof input === "string" && input.startsWith("/__openclaw__/workspace-icon/")) {
      return workspaceFetch(input, init);
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  return workspaceFetch;
}
