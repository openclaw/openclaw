import {
  createMemo,
  createRenderEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { registerMcpAppEnglish } from "../../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  readMcpAppContexts,
  publishMcpAppContext,
  subscribeMcpAppContexts,
  mcpAppContextItemTitle,
  mcpAppContextThumbnail,
  type McpAppContextEntry,
  type McpAppContextState,
} from "../../lib/mcp-app-context.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { Icon } from "./icon.tsx";
import "../../styles/mcp-app-extensions.css";

registerMcpAppEnglish();

type McpAppContextStripProps = { sessionKey: string; agentId: string };
export type McpAppContextStripElement = SolidBridgeElement<McpAppContextStripProps>;

export function McpAppContextStripContent(props: McpAppContextStripProps) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(new Set<string>());
  let mounted = true;
  onCleanup(() => {
    mounted = false;
  });
  createRenderEffect(
    () => gateway.read().snapshot.client,
    (client) =>
      client ? subscribeMcpAppContexts(client, () => setRevision((value) => value + 1)) : undefined,
  );
  const entries = createMemo(() => {
    revision();
    return readMcpAppContexts(gateway.read().snapshot.client, props.sessionKey, props.agentId);
  });
  onCleanup(
    context.gateway.subscribeEvents((event) =>
      untrack(() => {
        if (event.event !== "mcp.app.hostContextChanged") {
          return;
        }
        const payload = event.payload;
        if (
          !payload ||
          typeof payload !== "object" ||
          !("viewId" in payload) ||
          typeof payload.viewId !== "string"
        ) {
          return;
        }
        const client = context.gateway.snapshot.client;
        const entry = readMcpAppContexts(client, props.sessionKey, props.agentId).find(
          (item) => item.viewId === payload.viewId,
        );
        if (!client || !entry) {
          return;
        }
        if ("modelContext" in payload && payload.modelContext === null) {
          if (!("updateId" in payload) || payload.updateId !== entry.state?.updateId) {
            return;
          }
          publishMcpAppContext(client, { ...entry, state: null });
          return;
        }
        const publish = (state: McpAppContextState) =>
          publishMcpAppContext(client, { ...entry, state });
        void client
          .request<{ state: McpAppContextState }>("mcp.app.modelContext", {
            sessionKey: entry.sessionKey,
            agentId: entry.agentId,
            viewId: entry.viewId,
          })
          .then((result) => publish(result.state))
          .catch(() => publish(null));
      }),
    ),
  );
  async function removeItem(entry: McpAppContextEntry, index?: number) {
    const client = context.gateway.snapshot.client;
    const snapshot = entry.state;
    if (!client || !snapshot || context.gateway.snapshot.phase !== "connected") {
      return;
    }
    const scope = gatewayPresentationScope(context.gateway).key;
    const sessionKey = props.sessionKey;
    const agentId = props.agentId;
    setPending((value) => new Set([...value, entry.viewId]));
    setError(null);
    const current = () =>
      mounted &&
      context.gateway.snapshot.client === client &&
      gatewayPresentationScope(context.gateway).key === scope &&
      props.sessionKey === sessionKey &&
      props.agentId === agentId;
    try {
      const result = await client.request<{ state: McpAppContextState }>(
        "mcp.app.removeModelContext",
        {
          sessionKey: entry.sessionKey,
          agentId: entry.agentId,
          viewId: entry.viewId,
          updateId: snapshot.updateId,
          ...(index !== undefined ? { index } : {}),
        },
      );
      if (untrack(current)) {
        const rendered = readMcpAppContexts(client, sessionKey, agentId).find(
          (item) => item.viewId === entry.viewId,
        );
        if (rendered?.state?.updateId === snapshot.updateId) {
          publishMcpAppContext(client, { ...entry, state: result.state });
        }
      }
    } catch (failure) {
      if (untrack(current)) {
        setError(formatUiError(failure));
      }
    } finally {
      if (mounted) {
        setPending((value) => new Set([...value].filter((id) => id !== entry.viewId)));
      }
    }
  }
  return (
    <Show when={entries().length}>
      <section class="mcp-app-context" aria-label={t("mcpApp.contextTitle")}>
        <div class="mcp-app-context__header" title={t("mcpApp.contextDescription")}>
          <Icon name="puzzle" /> {t("mcpApp.contextTitle")}
        </div>
        <For each={entries()}>
          {(entry) => (
            <div class="mcp-app-context__items">
              <For each={entry.state?.content ?? []}>
                {(content, index) => {
                  const kind =
                    content.type === "image"
                      ? "mcpApp.imageContent"
                      : content.type === "text"
                        ? "mcpApp.textContent"
                        : "mcpApp.resourceContent";
                  const title = () =>
                    mcpAppContextItemTitle(content, `${entry.title} · ${t(kind)}`);
                  const thumbnail = mcpAppContextThumbnail(content);
                  return (
                    <div class="mcp-app-context__item">
                      {thumbnail ? (
                        <img
                          src={thumbnail}
                          alt={title()}
                          referrerpolicy="no-referrer"
                          loading="lazy"
                        />
                      ) : (
                        <Icon name="fileText" />
                      )}
                      <span class="mcp-app-context__label" title={title()}>
                        {title()}
                      </span>
                      <button
                        type="button"
                        disabled={pending().has(entry.viewId)}
                        aria-label={t("mcpApp.removeContext", { title: title() })}
                        onClick={() => void removeItem(entry, index())}
                      >
                        <Icon name="x" />
                      </button>
                    </div>
                  );
                }}
              </For>
              <Show when={entry.state?.structuredContent}>
                <div class="mcp-app-context__item">
                  <span>{entry.title}</span>
                  <button
                    type="button"
                    disabled={pending().has(entry.viewId)}
                    aria-label={t("mcpApp.removeContext", { title: entry.title })}
                    onClick={() => void removeItem(entry)}
                  >
                    <Icon name="x" />
                  </button>
                </div>
              </Show>
            </div>
          )}
        </For>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
      </section>
    </Show>
  );
}

export const McpAppContextStrip = defineSolidBridge<McpAppContextStripProps>(
  "openclaw-mcp-app-context-strip",
  (props) => <McpAppContextStripContent {...props} />,
  {
    properties: {
      sessionKey: { default: "", attribute: false },
      agentId: { default: "", attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-mcp-app-context-strip": McpAppContextStripElement;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-mcp-app-context-strip": HTMLAttributes<McpAppContextStripElement> &
        Properties<McpAppContextStripElement>;
    }
  }
}
