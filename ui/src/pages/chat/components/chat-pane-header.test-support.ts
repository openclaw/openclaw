import { nothing } from "lit";
import { createComponent, createSignal, flush } from "solid-js";
import { expect, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { LitContent } from "../../../lit/solid-content.tsx";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { renderChatPaneHeader } from "./chat-pane-header.ts";

export type ChatPaneHeaderProps = Parameters<typeof renderChatPaneHeader>[0];

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
 * Mounts the header with every required prop filled in. Callers own teardown so each suite
 * keeps its own afterEach; `containers` collects the mounted nodes for removal.
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
    sessionMenuAction: nothing,
    onBeginRename: vi.fn(),
    onRenameInput: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    onMenuOpenChange: vi.fn(),
    onMenuAction: vi.fn(),
    onOpenParentSession: vi.fn(),
    onBranchSelect: vi.fn(),
    ...patch,
  };
  const [current, setCurrent] = createSignal(props);
  const mounted = mountSolid(
    () =>
      createComponent(LitContent, {
        get value() {
          return renderChatPaneHeader(current());
        },
      }),
    { container },
  );
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
