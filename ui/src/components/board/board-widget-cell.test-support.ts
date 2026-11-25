import { vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type {
  BoardWidgetCellCallbacks,
  BoardWidgetCellProps,
} from "./board-widget-cell-options.ts";

export function callbacks(
  overrides: Partial<BoardWidgetCellCallbacks> = {},
): BoardWidgetCellCallbacks {
  const noAction = vi.fn(async () => undefined);
  return {
    appViewGeneration: () => 0,
    grant: noAction,
    movePointerDown: vi.fn(),
    resizePointerDown: vi.fn(),
    moveToTab: noAction,
    resizeTo: noAction,
    setHeightMode: noAction,
    reportContentHeight: vi.fn(),
    remove: noAction,
    nudge: noAction,
    focus: vi.fn(),
    focusChanged: vi.fn(),
    frameLoadFailed: noAction,
    widgetAppView: vi.fn(async () => ({ status: "stale" as const })),
    refreshWidgetAppView: vi.fn(async () => ({ status: "stale" as const })),
    ...overrides,
  };
}

const disposers: Array<() => void> = [];
export function mountElement(element: HTMLElement): void {
  disposers.push(mountSolid(() => element, { container: document.body }).unmount);
}
export function cleanupCells(): void {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  document.body.replaceChildren();
}

export function mountCell(
  widget: NonNullable<BoardWidgetCellProps["widget"]>,
  options: Partial<BoardWidgetCellProps> & {
    context?: ApplicationContext;
    scopedSession?: boolean;
  } = {},
) {
  const { context, scopedSession, ...props } = options;
  const cell = document.createElement("openclaw-board-widget-cell");
  Object.assign(cell, {
    widget,
    rect: { name: widget.name, x: 0, y: widget.position * 4, w: 6, h: widget.sizeH },
    callbacks: props.callbacks ?? callbacks(),
    ...props,
  });
  if (scopedSession && props.sessionKey) {
    cell.session = {
      sessionKey: props.sessionKey.endsWith(":global") ? "global" : props.sessionKey,
      agentId: props.sessionKey.split(":")[1],
    };
  }
  const root = context ? createApplicationContextProvider(context) : cell;
  if (root !== cell) {
    root.append(cell);
  }
  mountElement(root);
  return cell;
}
