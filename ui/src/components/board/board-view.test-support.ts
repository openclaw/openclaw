import { flush } from "solid-js";
import { expect, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { BoardSnapshot, BoardWidget } from "../../lib/board/types.ts";
import type { BoardViewCallbacks } from "../../lib/board/view-types.ts";
import { createBoardWidget } from "../../lib/board/widget.test-support.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";

type OpenClawBoardView = HTMLElementTagNameMap["openclaw-board-view"];

export const testId = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(`[data-test-id="${id}"]`);
export function expectText(element: Element | null | undefined, ...contents: string[]) {
  contents.forEach((content) => expect(element?.textContent).toContain(content));
}
export const widgetSnapshot = (widget: Partial<BoardWidget> = {}) =>
  snapshot({ widgets: [boardWidget(widget)] });

export async function openBoardMenu(
  root: ParentNode,
  selector = ".board-widget__menu-trigger",
): Promise<void> {
  const trigger = root.querySelector<HTMLButtonElement>(selector)!;
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
}

export const boardWidget = (overrides: Partial<BoardWidget> = {}): BoardWidget =>
  createBoardWidget({ title: "Alpha status", ...overrides });

export const snapshot = (overrides: Partial<BoardSnapshot> = {}): BoardSnapshot => ({
  sessionKey: "agent:main:test",
  revision: 1,
  tabs: [
    { tabId: "main", title: "Main", position: 0, chatDock: "right" },
    { tabId: "ops", title: "Operations", position: 1, chatDock: "bottom" },
  ],
  widgets: [
    boardWidget(),
    boardWidget({ name: "beta", title: "Beta chart", position: 1, revision: 2 }),
    boardWidget({ name: "ops-only", title: "Queue depth", tabId: "ops", sizeW: 12 }),
  ],
  ...overrides,
});

export const callbacks = (overrides: Partial<BoardViewCallbacks> = {}): BoardViewCallbacks => ({
  applyOps: vi.fn(async () => undefined),
  grant: vi.fn(async () => undefined),
  selectTab: vi.fn(),
  ...overrides,
});

export function gatewayContext(client: { request: GatewayRequestHandler } | null, basePath = "") {
  const { gateway } = createApplicationGateway();
  gateway.connection.gatewayUrl = "";
  gateway.snapshot.client = client ? createTestGatewayClient(client.request) : null;
  gateway.snapshot.phase = "connected";
  return { basePath, gateway } as unknown as ApplicationContext;
}

export async function settleCells(view: OpenClawBoardView) {
  flush();
  await view.updateComplete;
  const cells = [...view.querySelectorAll("openclaw-board-widget-cell")];
  await Promise.all(cells.map((cell) => cell.updateComplete));
  flush();
  await view.updateComplete;
  return cells;
}

export async function mount(
  options: Partial<
    Pick<
      OpenClawBoardView,
      "snapshot" | "activeTabId" | "callbacks" | "widgetFrameUrl" | "canMutate" | "canGrant"
    >
  > & { context?: ApplicationContext } = {},
): Promise<OpenClawBoardView> {
  const view = document.createElement("openclaw-board-view");
  view.snapshot = options.snapshot ?? snapshot();
  view.activeTabId = options.activeTabId ?? "main";
  view.widgetFrameUrl = options.widgetFrameUrl ?? (() => "about:blank");
  view.callbacks = options.callbacks ?? callbacks();
  view.canMutate = options.canMutate ?? true;
  view.canGrant = options.canGrant ?? true;
  const root = options.context ? createApplicationContextProvider(options.context) : view;
  if (root !== view) {
    root.append(view);
  }
  mountSolid(() => root);
  await settleCells(view);
  return view;
}

export const mountWidget = (widget: Partial<BoardWidget> = {}) =>
  mount({ snapshot: widgetSnapshot(widget) });
