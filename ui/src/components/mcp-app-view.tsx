import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { formatUiError } from "../lib/format-error.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { McpAppConfirmation } from "./mcp-app-confirm-solid.tsx";
import {
  McpAppViewController,
  type McpAppViewProps,
  type McpAppViewElement,
  type ViewMethods,
} from "./mcp-app-view-controller.ts";
import "../styles/mcp-app-view.css";

export type { McpAppViewProps, McpAppViewElement } from "./mcp-app-view-controller.ts";
const controllers = new WeakMap<McpAppViewElement, McpAppViewController>();

export const McpAppView = defineSolidBridge<McpAppViewProps, ViewMethods>(
  "mcp-app-view",
  (props, host) => {
    const context = useApplication();
    const gateway = context ? projectGateway(context.gateway) : undefined;
    const [revision, setRevision] = createSignal(0, { ownedWrite: true });
    const controller = new McpAppViewController(host, context, () =>
      setRevision((value) => value + 1),
    );
    const read = () => {
      revision();
      return controller;
    };
    controllers.set(host, controller);
    const binding = createMemo(
      () => {
        gateway?.read();
        return [
          context?.gateway.snapshot.client,
          props.sessionKey,
          props.viewId,
          props.agentId,
          context?.gateway.connectionRevision,
          context?.gateway.snapshot.hello,
        ] as const;
      },
      { equals: (a, b) => a.every((value, index) => value === b[index]) },
    );
    createEffect(binding, () => {
      void controller.setup(controller.binding());
    });
    createEffect(
      () => [props.title, t("mcpApp.title")],
      () => {
        controller.updateTitle();
      },
    );
    const presentation = createMemo(
      () => [props.height, props.fillContainer, props.displayMode, props.deepLink],
      { equals: (a, b) => a.every((value, index) => value === b[index]) },
    );
    createEffect(presentation, () => controller.updatePresentation());
    onCleanup(() => {
      controllers.delete(host);
      void controller.teardown();
    });
    const relaunch = () => (read().inactive === "ended" ? props.onRelaunch : undefined);
    return (
      <>
        <Show when={props.displayMode === "fullscreen"}>
          <button
            class="exit-fullscreen"
            onClick={() => {
              host.displayMode = "inline";
            }}
          >
            {t("common.close")}
          </button>
        </Show>
        <Show when={read().inactive && props.surface === "conversation"}>
          <div class="inactive" role="status">
            <span>{t(relaunch() ? "mcpApp.sessionEnded" : "mcpApp.reconstructed")}</span>
            <Show when={relaunch()}>
              {(action) => (
                <button type="button" disabled={props.relaunching} onClick={() => action()()}>
                  {t("mcpApp.relaunch")}
                </button>
              )}
            </Show>
          </div>
        </Show>
        <McpAppConfirmation confirmation={controller.confirmation} revision={revision()} />
        <div
          ref={(element) => {
            controller.mount = element;
          }}
          class="mount"
        />
        <Show when={read().inactive !== "ended" && read().error}>
          {(error) => (
            <div class="error">
              {t("mcpApp.unavailable", {
                error: formatUiError(error(), t("mcpApp.errors.requestFailed")),
              })}
            </div>
          )}
        </Show>
      </>
    );
  },
  {
    properties: {
      sessionKey: { default: "", attribute: false },
      agentId: { default: "", attribute: false },
      viewId: { default: "", attribute: false },
      height: { default: 600 },
      fillContainer: { default: false, attribute: "fill-container", reflect: true },
      surface: { default: "conversation", attribute: false },
      title: { default: "" },
      deepLink: { default: undefined, attribute: false },
      onRelaunch: { default: undefined, attribute: false },
      relaunching: { default: false },
      displayMode: { default: "inline", attribute: "display-mode", reflect: true },
    },
    methods: {
      teardown: (host) => controllers.get(host)?.teardown() ?? Promise.resolve(),
      restartAfterTeardown: (host) => controllers.get(host)?.restartAfterTeardown(),
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "mcp-app-view": McpAppViewElement;
  }
}
