import { createEffect, createMemo, onCleanup, Show } from "solid-js";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { hasOperatorReadAccess } from "../app/operator-access.ts";
import { formatUiError } from "../lib/format-error.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { McpAppConfirmation } from "./mcp-app-confirm-solid.tsx";
import {
  createMcpAppView,
  type McpAppViewOwner,
  type McpAppViewProps,
  type McpAppViewElement,
  type ViewMethods,
} from "./mcp-app-view-owner.ts";
import "../styles/mcp-app-view.css";

const owners = new WeakMap<McpAppViewElement, McpAppViewOwner>();

export const McpAppView = defineSolidBridge<McpAppViewProps, ViewMethods>(
  "mcp-app-view",
  (props, host) => {
    const context = useApplication();
    const gateway = projectGateway(context.gateway);
    const owner = createMcpAppView(host, context);
    const read = projectOwner(owner, (current) => current.read()).read;
    owners.set(host, owner);
    let { client, phase, hello } = context.gateway.snapshot;
    const stopConnection = context.gateway.subscribe((snapshot) => {
      if (snapshot.client !== client || snapshot.phase !== phase || snapshot.hello !== hello) {
        owner.connectionChanged();
      }
      ({ client, phase, hello } = snapshot);
    });
    const binding = createMemo(
      () => {
        gateway.read();
        return [
          context.gateway.snapshot.client,
          props.sessionKey,
          props.viewId,
          props.agentId,
          context.gateway.connectionRevision,
          gatewayPresentationScope(context.gateway).key,
          context.gateway.snapshot.phase === "connected" &&
            context.gateway.snapshot.hello !== null &&
            !hasOperatorReadAccess(context.gateway.snapshot.hello.auth ?? null),
        ] as const;
      },
      { equals: (a, b) => a.every((value, index) => value === b[index]) },
    );
    createEffect(binding, () => {
      void owner.setup(owner.currentBinding());
    });
    createEffect(
      () => [props.title, t("mcpApp.title")],
      () => {
        owner.updateTitle();
      },
    );
    const presentation = createMemo(
      () => [props.height, props.fillContainer, props.displayMode, props.deepLink],
      { equals: (a, b) => a.every((value, index) => value === b[index]) },
    );
    createEffect(presentation, () => owner.updatePresentation());
    createEffect(
      () => props.surface,
      () => owner.updateReservedHeight(),
    );
    onCleanup(() => {
      stopConnection();
      owners.delete(host);
      void owner.teardown();
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
