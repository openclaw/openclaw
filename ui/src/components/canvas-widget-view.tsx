import { createEffect, createMemo, onCleanup } from "solid-js";
import { registerBoardEnglish } from "../i18n/locales/en-board.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { projectCallbackOwner } from "../lib/reactive/callback-owner.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { createDocumentVisibility } from "../lib/reactive/platform.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { CanvasWidgetFrame, resolveCanvasWidgetFrameSource } from "./canvas-widget-frame.tsx";
import { createCanvasWidget, type CanvasWidgetViewProps } from "./canvas-widget-view-owner.ts";

registerEnglishCatalog(registerBoardEnglish);

type CanvasWidgetViewContent = {
  readonly documentHtml: string | undefined;
  readonly previewFrame: HTMLIFrameElement | undefined;
};
export type OpenClawCanvasWidgetView = SolidBridgeElement<
  CanvasWidgetViewProps,
  CanvasWidgetViewContent
>;

export const CanvasWidgetView = defineSolidBridge<CanvasWidgetViewProps, CanvasWidgetViewContent>(
  "openclaw-canvas-widget-view",
  (props, host) => {
    host.style.display = "contents";
    host.style.minHeight = "";
    const context = useApplication();
    const gateway = projectGateway(context.gateway);
    const documentVisible = createDocumentVisibility();
    const { owner: widget, view: projection } = projectCallbackOwner(
      (notify) => {
        const owner = createCanvasWidget(host, host, context, notify);
        onCleanup(owner.clearView);
        return owner;
      },
      (owner) => owner.state,
    );
    const scriptProperty = Object.getOwnPropertyDescriptor(host, "allowScripts")!;
    // Even a false→true change within one commit must revoke the old private port.
    Object.defineProperty(host, "allowScripts", {
      ...scriptProperty,
      set(value: boolean) {
        if (value !== host.allowScripts) {
          widget.retireScriptPolicy();
        }
        scriptProperty.set!.call(host, value);
        widget.notify();
      },
    });
    const read = projection.read;
    // Admit authenticated reads and retire stale sandbox authority when external identity changes.
    createEffect(
      () => [
        props.docId,
        props.sessionKey,
        props.connectionGeneration,
        props.allowScripts,
        props.inputPreview,
        props.presentationActive,
        gateway.read(),
      ],
      () => {
        widget.reconcile();
        widget.notify();
      },
    );
    createEffect(
      () => [projection.revision(), props.presentationActive, documentVisible()],
      (inputs) => widget.syncSandbox(inputs[2]),
    );
    onCleanup(() => {
      Object.defineProperty(host, "allowScripts", scriptProperty);
    });
    const retry = () => {
      widget.clearView();
      widget.reconcile();
      widget.notify();
    };
    const source = createMemo(() =>
      resolveCanvasWidgetFrameSource(
        read().view,
        read().inputShell,
        props.allowScripts,
        context.gateway.connection.gatewayUrl,
      ),
    );
    const height = () =>
      read().contentHeight ?? props.preferredHeight ?? (props.inputPreview ? 0 : 420);
    return (
      <CanvasWidgetFrame
        state={read()}
        source={source()}
        height={height()}
        title={props.title}
        allowScripts={props.allowScripts}
        input={Boolean(props.inputPreview)}
        onRetry={retry}
        onFrame={widget.setFrame}
        onFrameError={widget.syncFrameError}
      />
    );
  },
  {
    properties: {
      docId: { default: "" },
      sessionKey: { default: "" },
      messageTimestamp: { default: undefined, type: Number },
      title: { default: "" },
      preferredHeight: { default: undefined, type: Number },
      onHeightChange: { default: undefined, attribute: false },
      connectionGeneration: { default: 0 },
      presentationActive: { default: true },
      allowScripts: { default: true },
      inputPreview: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-canvas-widget-view": OpenClawCanvasWidgetView;
  }
}
