import { createSignal, flush } from "solid-js";
import type { BoardWidget } from "../../lib/board/types.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  BoardWidgetFrame,
  createBoardWidgetFrame,
  type BoardWidgetFrameOwner,
} from "./board-widget-frame.tsx";

export function grantedFrameWidgetFixture(): BoardWidget {
  return {
    name: "weather",
    revision: 1,
    tabId: "main",
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "granted",
    viewTicket: "ticket",
    viewGeneration: "generation",
    sandboxUrl: "/mcp-app-sandbox",
    sandboxPort: 8444,
    sandboxOrigin: "https://sandbox.example",
  };
}

type FrameHost = Parameters<typeof createBoardWidgetFrame>[0];

export function createFrameOwner(
  widget: FrameHost["widget"],
  overrides: Partial<Omit<FrameHost, "widget">> = {},
) {
  return createBoardWidgetFrame({
    active: () => true,
    connected: () => true,
    context: () => undefined,
    refreshFrame: () => undefined,
    reportContentHeight: () => {},
    scrollBy: () => {},
    resolveFrameUrl: () => () => "",
    widget,
    ...overrides,
  });
}

export function mountBoardWidgetFrame(
  owner: BoardWidgetFrameOwner,
  widget: BoardWidget | (() => BoardWidget),
  root: HTMLElement,
  disposers: Array<() => void>,
) {
  const [revision, setRevision] = createSignal(0);
  const view = mountSolid(
    () => {
      const state = projectOwner(owner, (current) => current);
      return (
        <BoardWidgetFrame
          state={state.read}
          current={() => {
            revision();
            return typeof widget === "function" ? widget() : widget;
          }}
        />
      );
    },
    { container: root },
  );
  disposers.push(view.unmount);
  flush();
  return () => {
    setRevision((value) => value + 1);
    flush();
  };
}

export function dispatchFrameMessage(
  frame: HTMLIFrameElement,
  init: Omit<MessageEventInit, "source">,
) {
  return window.dispatchEvent(
    new MessageEvent("message", { source: frame.contentWindow, ...init }),
  );
}

export function acknowledgeWidgetHostInit(port: MessagePort, ready: { resolve: () => void }) {
  port.addEventListener("message", (event) => {
    if (event.data.type === "openclaw:widget-host-init") {
      port.postMessage({
        type: "openclaw:widget-host-init-ack",
        ticket: event.data.ticket,
      });
      ready.resolve();
    }
  });
}
