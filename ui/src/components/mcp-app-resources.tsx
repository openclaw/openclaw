import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type {
  McpAppMentionResult,
  McpAppResourceLink,
} from "../../../src/shared/mcp-app-extensions.js";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../lib/format-error.ts";
import { createMcpAppCatalog } from "../lib/mcp-app-catalog.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
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
type McpAppResourcesElement = SolidBridgeElement<McpAppResourcesProps>;

function McpAppResourcesContent(props: McpAppResourcesProps, host: HTMLElement) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  let generation = 0;
  let mounted = true;
  // Native inputs expose same-turn edits before their presentation signals settle.
  let queryInput: HTMLInputElement | undefined;
  let serverSelect: HTMLSelectElement | undefined;
  const catalog = createMcpAppCatalog(context, () => ({
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
  // Keep each committed identity distinct even while the picker has no visible consumers.
  const requestScope = createMemo(() => ({ identity: identity() }));
  type ResourceView = {
    expanded: boolean;
    query: string;
    generation: number;
    resources: McpAppResourceLink[];
    busy: boolean;
    searched: boolean;
    error: string | null;
  };
  // A new scope retires results while preserving the user's disclosure and query.
  const [view, setView] = createSignal<ResourceView>((previous) => {
    requestScope();
    return {
      expanded: previous?.expanded ?? false,
      query: previous?.query ?? "",
      generation,
      resources: [],
      busy: false,
      searched: false,
      error: null,
    };
  });
  const servers = createMemo(() => catalog().servers.filter((server) => server.mentionTool));
  const [serverName, setServerName] = createSignal<string>((previous = "") => {
    const available = servers();
    return available.length && !available.some((server) => server.serverName === previous)
      ? available[0]!.serverName
      : previous;
  });

  async function search() {
    const client = context.gateway.snapshot.client;
    const selectedServer = serverSelect?.value ?? serverName();
    if (!client || !catalog().available || !selectedServer) {
      return;
    }
    const searchGeneration = ++generation;
    const searchScope = requestScope();
    const sessionKey = props.sessionKey;
    const agentId = props.agentId;
    const current = () =>
      mounted &&
      host.isConnected &&
      generation === searchGeneration &&
      context.gateway.snapshot.client === client &&
      requestScope() === searchScope;
    setView((previous) => ({
      ...previous,
      generation: searchGeneration,
      busy: true,
      error: null,
      resources: [],
    }));
    try {
      const { resources } = await client.request<McpAppMentionResult>("mcp.app.mention", {
        sessionKey,
        agentId,
        serverName: selectedServer,
        query: queryInput?.value ?? view().query,
      });
      if (current()) {
        setView((previous) => ({ ...previous, resources, searched: true, busy: false }));
      }
    } catch (error) {
      if (current()) {
        setView((previous) => ({
          ...previous,
          busy: false,
          error:
            asOptionalRecord(asOptionalRecord(error)?.details)?.code ===
            "MCP_APP_UNSUPPORTED_MENTION_RESULT"
              ? t("mcpApp.errors.unsupportedResources")
              : formatUiError(error),
        }));
      }
    }
  }
  function attach(resource: McpAppResourceLink) {
    const current = view();
    // Input changes retire retained result buttons before the next DOM commit.
    if (
      context.gateway.snapshot.phase !== "connected" ||
      current.generation !== generation ||
      !current.resources.includes(resource)
    ) {
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
    setView((previous) =>
      claimed
        ? { ...previous, expanded: false }
        : { ...previous, error: t("mcpApp.errors.mountUnavailable") },
    );
  }
  return (
    <Show when={servers().length}>
      <section class="mcp-app-resources">
        <button
          type="button"
          class="btn btn--sm"
          aria-expanded={view().expanded ? "true" : "false"}
          onClick={() => {
            setView((previous) => ({ ...previous, expanded: !previous.expanded }));
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
              ref={(element) => (serverSelect = element)}
              aria-label={t("mcpApp.title")}
              value={serverName()}
              disabled={view().busy}
              onChange={(event) => {
                setServerName(event.currentTarget.value);
                generation++;
                setView((previous) => ({ ...previous, resources: [], searched: false }));
              }}
            >
              <For each={servers()} keyed={(server) => server.serverName}>
                {(server) => <option value={server().serverName}>{server().label}</option>}
              </For>
            </select>
            <input
              ref={(element) => (queryInput = element)}
              type="search"
              aria-label={t("mcpApp.resourceSearch")}
              placeholder={t("mcpApp.resourceQuery")}
              value={view().query}
              onInput={(event) => {
                const query = event.currentTarget.value;
                generation++;
                setView((previous) => ({
                  ...previous,
                  query,
                  busy: false,
                  resources: [],
                  searched: false,
                }));
              }}
            />
            <button class="btn" type="submit" disabled={view().busy || !catalog().available}>
              {t("mcpApp.resourceSearch")}
            </button>
          </form>
          <div class="mcp-app-resources__results">
            <For each={view().resources}>
              {(resource) => (
                <button
                  type="button"
                  class="btn mcp-app-resources__result"
                  disabled={view().busy || !catalog().available}
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

defineSolidBridge<McpAppResourcesProps>("openclaw-mcp-app-resources", McpAppResourcesContent, {
  properties: {
    sessionKey: { default: "", attribute: false },
    agentId: { default: "", attribute: false },
  },
});

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-mcp-app-resources": McpAppResourcesElement;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-mcp-app-resources": HTMLAttributes<McpAppResourcesElement> &
        Properties<McpAppResourcesElement> & {
          "onOpenclaw-mcp-app-resource-mention"?: EventHandlerUnion<
            McpAppResourcesElement,
            CustomEvent<McpAppResourceMentionDetail>
          >;
        };
    }
  }
}
