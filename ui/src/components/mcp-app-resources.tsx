import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createMemo,
  createRenderEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import type {
  McpAppMentionResult,
  McpAppResourceLink,
} from "../../../src/shared/mcp-app-extensions.js";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../lib/format-error.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { useMcpAppCatalog } from "../lib/reactive/mcp-app-catalog.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { Icon } from "./solid/icon.tsx";
import "../styles/mcp-app-extensions.css";

registerMcpAppEnglish();

export const MCP_APP_RESOURCE_MENTION_EVENT = "openclaw-mcp-app-resource-mention";
export type McpAppResourceMentionDetail = {
  sessionKey: string;
  agentId: string;
  serverName: string;
  resource: McpAppResourceLink;
};
type McpAppResourcesProps = { sessionKey: string; agentId: string };
export type McpAppResourcesElement = SolidBridgeElement<McpAppResourcesProps>;

function McpAppResourcesContent(props: McpAppResourcesProps & { host: HTMLElement }) {
  const context = useApplication();
  const host = untrack(() => props.host);
  const gateway = projectGateway(context.gateway);
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const invalidate = () => setRevision((value) => value + 1);
  const state: {
    expanded: boolean;
    serverName: string;
    query: string;
    resources: McpAppResourceLink[];
    busy: boolean;
    searched: boolean;
    error: string | null;
  } = {
    expanded: false,
    serverName: "",
    query: "",
    resources: [],
    busy: false,
    searched: false,
    error: null,
  };
  const view = () => {
    revision();
    return state;
  };
  let generation = 0;
  let mounted = true;
  const catalog = useMcpAppCatalog(context, () => ({
    sessionKey: props.sessionKey,
    agentId: props.agentId,
  }));
  onCleanup(() => {
    mounted = false;
    generation++;
  });
  const identity = createMemo(() => {
    gateway.read();
    return JSON.stringify([
      gatewayPresentationScope(context.gateway).key,
      props.sessionKey,
      props.agentId,
    ]);
  });
  createRenderEffect(identity, () => {
    generation++;
    state.resources = [];
    state.error = null;
    state.searched = false;
    state.busy = false;
    invalidate();
  });
  const servers = createMemo(() => {
    return catalog().servers.filter((server) => server.mentionTool);
  });
  createRenderEffect(servers, (available) => {
    if (available.length && !available.some((server) => server.serverName === state.serverName)) {
      state.serverName = available[0]!.serverName;
      invalidate();
    }
  });
  const serverName = () => view().serverName;

  async function search() {
    const client = context.gateway.snapshot.client;
    const selectedServer = serverName();
    if (!client || !selectedServer) {
      return;
    }
    const searchGeneration = ++generation;
    const searchIdentity = identity();
    const sessionKey = props.sessionKey;
    const agentId = props.agentId;
    const current = () =>
      mounted &&
      host.isConnected &&
      generation === searchGeneration &&
      context.gateway.snapshot.client === client &&
      identity() === searchIdentity;
    state.busy = true;
    state.error = null;
    state.resources = [];
    invalidate();
    try {
      const result = await client.request<McpAppMentionResult>("mcp.app.mention", {
        sessionKey,
        agentId,
        serverName: selectedServer,
        query: state.query,
      });
      if (current()) {
        state.resources = result.resources;
        state.searched = true;
      }
    } catch (error) {
      if (current()) {
        state.error =
          asOptionalRecord(asOptionalRecord(error)?.details)?.code ===
          "MCP_APP_UNSUPPORTED_MENTION_RESULT"
            ? t("mcpApp.errors.unsupportedResources")
            : formatUiError(error);
      }
    } finally {
      if (current()) {
        state.busy = false;
        invalidate();
      }
    }
  }
  function attach(resource: McpAppResourceLink) {
    if (context.gateway.snapshot.phase !== "connected" || !state.resources.includes(resource)) {
      return;
    }
    const claimed = !host.dispatchEvent(
      new CustomEvent<McpAppResourceMentionDetail>(MCP_APP_RESOURCE_MENTION_EVENT, {
        bubbles: true,
        composed: true,
        cancelable: true,
        detail: {
          sessionKey: props.sessionKey,
          agentId: props.agentId,
          serverName: serverName(),
          resource,
        },
      }),
    );
    if (claimed) {
      state.expanded = false;
    } else {
      state.error = t("mcpApp.errors.mountUnavailable");
    }
    invalidate();
  }
  return (
    <Show when={servers().length}>
      <section class="mcp-app-resources">
        <button
          type="button"
          class="btn btn--sm"
          aria-expanded={view().expanded ? "true" : "false"}
          onClick={() => {
            state.expanded = !state.expanded;
            invalidate();
          }}
        >
          <Icon name="link" /> {t("mcpApp.resources")}
        </button>
        <Show when={view().expanded}>
          <p class="muted">{t("mcpApp.resourceDescription")}</p>
          <form
            class="mcp-app-resources__search"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <select
              aria-label={t("mcpApp.title")}
              value={serverName()}
              disabled={view().busy}
              onChange={(event) => {
                state.serverName = event.currentTarget.value;
                generation++;
                state.resources = [];
                state.searched = false;
                invalidate();
              }}
            >
              <For each={servers()} keyed={(server) => server.serverName}>
                {(server) => <option value={server().serverName}>{server().label}</option>}
              </For>
            </select>
            <input
              type="search"
              aria-label={t("mcpApp.resourceSearch")}
              placeholder={t("mcpApp.resourceQuery")}
              value={view().query}
              onInput={(event) => {
                state.query = event.currentTarget.value;
                generation++;
                state.busy = false;
                state.resources = [];
                state.searched = false;
                invalidate();
              }}
            />
            <button class="btn" type="submit" disabled={view().busy}>
              {t("mcpApp.resourceSearch")}
            </button>
          </form>
          <div class="mcp-app-resources__results">
            <For each={view().resources}>
              {(resource) => (
                <button
                  type="button"
                  class="btn mcp-app-resources__result"
                  disabled={view().busy}
                  onClick={() => attach(resource)}
                >
                  <span>{resource.title || resource.name}</span>
                  <small>{resource.description || resource.uri}</small>
                </button>
              )}
            </For>
          </div>
          <Show when={view().searched && !view().resources.length}>
            <p role="status">{t("mcpApp.noResources")}</p>
          </Show>
        </Show>
        <Show when={view().error}>
          <p role="alert">{view().error}</p>
        </Show>
      </section>
    </Show>
  );
}

export const McpAppResources = defineSolidBridge<McpAppResourcesProps>(
  "openclaw-mcp-app-resources",
  (props, host) => <McpAppResourcesContent {...props} host={host} />,
  {
    properties: {
      sessionKey: { default: "", attribute: false },
      agentId: { default: "", attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-mcp-app-resources": McpAppResourcesElement;
  }
}
