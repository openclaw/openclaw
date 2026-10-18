import { flush } from "solid-js";
import { expect, onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { BoardSnapshot, BoardWidget } from "../../lib/board/types.ts";
import type { BoardViewCallbacks } from "../../lib/board/view-types.ts";
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
type OpenClawBoardWidgetCell = HTMLElementTagNameMap["openclaw-board-widget-cell"];

export async function openBoardMenu(
  root: ParentNode,
  selector = ".board-widget__menu-trigger",
): Promise<void> {
  const trigger = root.querySelector<HTMLButtonElement>(selector)!;
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
}

export function boardWidget(overrides: Partial<BoardWidget> = {}): BoardWidget {
  return {
    name: "alpha",
    tabId: "main",
    title: "Alpha status",
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "none",
    revision: 1,
    ...overrides,
  };
}

export function snapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    sessionKey: "agent:main:test",
    revision: 1,
    tabs: [
      { tabId: "main", title: "Main", position: 0, chatDock: "right" },
      { tabId: "ops", title: "Operations", position: 1, chatDock: "bottom" },
    ],
    widgets: [
      boardWidget(),
      boardWidget({
        name: "beta",
        title: "Beta chart",
        sizeW: 6,
        position: 1,
        revision: 2,
      }),
      boardWidget({
        name: "ops-only",
        title: "Queue depth",
        tabId: "ops",
        sizeW: 12,
      }),
    ],
    ...overrides,
  };
}

export function callbacks(overrides: Partial<BoardViewCallbacks> = {}): BoardViewCallbacks {
  return {
    applyOps: vi.fn(async () => undefined),
    grant: vi.fn(async () => undefined),
    selectTab: vi.fn(),
    ...overrides,
  };
}

export function gatewayContext(client: { request: GatewayRequestHandler } | null, basePath = "") {
  const { gateway } = createApplicationGateway();
  gateway.connection.gatewayUrl = "";
  gateway.snapshot.client = client ? createTestGatewayClient(client.request) : null;
  gateway.snapshot.phase = "connected";
  return {
    basePath,
    gateway,
  } as unknown as ApplicationContext;
}

export async function settleCells(view: OpenClawBoardView): Promise<OpenClawBoardWidgetCell[]> {
  flush();
  await view.updateComplete;
  const cells = [...view.querySelectorAll("openclaw-board-widget-cell")];
  await Promise.all(cells.map((cell) => cell.updateComplete));
  flush();
  await view.updateComplete;
  return cells;
}

export async function mount(
  options: {
    snapshot?: BoardSnapshot;
    activeTabId?: string;
    callbacks?: BoardViewCallbacks;
    widgetFrameUrl?: (name: string, revision: number) => string;
    context?: ApplicationContext;
    canMutate?: boolean;
    canGrant?: boolean;
  } = {},
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
  const mounted = mountSolid(() => root);
  onTestFinished(() => mounted.unmount());
  await settleCells(view);
  return view;
}
