import { onCleanup, onSettled, Show } from "solid-js";
import { formatUiError } from "../lib/format-error.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { projectCallbackOwner } from "../lib/reactive/callback-owner.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { McpAppConfirmation } from "./mcp-app-confirm-solid.tsx";
import { registerMcpAppUnmountTarget } from "./mcp-app-unmount.ts";
import { createMcpAppView, type McpAppViewOwner } from "./mcp-app-view-owner.ts";
import type { McpAppViewProps, McpAppViewElement, ViewMethods } from "./mcp-app-view-types.ts";
import "../styles/mcp-app-view.css";

const owners = new WeakMap<McpAppViewElement, McpAppViewOwner>();

export const McpAppView = defineSolidBridge<McpAppViewProps, ViewMethods>(
  "mcp-app-view",
  (props, host) => {
    const context = useApplication();
    const gateway = projectGateway(context.gateway);
    const { owner, view } = projectCallbackOwner(
      (notify) => createMcpAppView(host, context, onSettled, notify),
      (current) => current.read(),
    );
    const read = view.read;
    owners.set(host, owner);
    const unregister = registerMcpAppUnmountTarget(host);
    onSettled(() => owner.start());
    // Retire bridge methods and host registration even if disposal precedes the first settle.
    onCleanup(() => {
      unregister();
      owners.delete(host);
      owner.dispose();
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
        <McpAppConfirmation confirmation={owner.confirmation} />
        <div
          ref={(element) => {
            owner.setMount(element);
          }}
          class="mount"
        />
        <Show when={read().inactive !== "ended" && read().error}>
          {(error) => (
            <div class="error">
              {t("mcpApp.unavailable", {
                error: formatUiError(error(), t("mcpApp.errors.requestFailed")),
              })}
              <button
                type="button"
                disabled={gateway.read().snapshot.phase !== "connected"}
                onClick={() => void owner.setup(owner.currentBinding())}
              >
                {t("mcpApp.retry")}
              </button>
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
      onHeightChange: { default: undefined, attribute: false },
      relaunching: { default: false },
      displayMode: { default: "inline", attribute: "display-mode", reflect: true },
    },
    propertyChanged: (host) => owners.get(host)?.inputChanged(),
    methods: {
      teardown: (host) => owners.get(host)?.teardown() ?? Promise.resolve(),
      restartAfterTeardown: (host) => owners.get(host)?.restartAfterTeardown(),
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "mcp-app-view": McpAppViewElement;
  }
}
