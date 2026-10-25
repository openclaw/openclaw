import {
  action,
  createMemo,
  createOptimisticStore,
  createSignal,
  For,
  onSettled,
  Show,
} from "solid-js";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { registerMcpAppEnglish } from "../../i18n/locales/en-mcp-app.ts";
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
import { projectSource } from "../../lib/reactive/projection.ts";
import { Icon } from "./icon.tsx";
import { McpAppOperationError } from "./mcp-app-operation-error.tsx";
import "../../styles/mcp-app-extensions.css";

registerMcpAppEnglish();

type McpAppContextStripProps = { sessionKey: string; agentId: string };

export function McpAppContextStrip(props: McpAppContextStripProps) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const [removal, setRemoval] = createSignal<{
    current: () => boolean;
    result: Promise<null>;
  }>();
  const currentRemoval = () => {
    const admitted = removal();
    return admitted?.current() ? admitted : undefined;
  };
  const [pending, setPending] = createOptimisticStore<Record<string, (() => boolean) | undefined>>(
    {},
  );
  const refreshes = new WeakMap<McpAppContextEntry, Promise<{ state: McpAppContextState }>>();
  let mounted = false;
  const contexts = createMemo(() => {
    const client = gateway.read().snapshot.client;
    const sessionKey = props.sessionKey;
    const agentId = props.agentId;
    return projectSource(client, {
      read: (source) => readMcpAppContexts(source, sessionKey, agentId),
      subscribe: (source, notify) => (source ? subscribeMcpAppContexts(source, notify) : () => {}),
      equality: "revision",
    });
  });
  onSettled(() => {
    mounted = true;
    const stop = context.gateway.subscribeEvents((event) => {
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
      const scope = gatewayPresentationScope(context.gateway).key;
      const sessionKey = props.sessionKey;
      const agentId = props.agentId;
      const request = client.request<{ state: McpAppContextState }>("mcp.app.modelContext", {
        sessionKey: entry.sessionKey,
        agentId: entry.agentId,
        viewId: entry.viewId,
      });
      refreshes.set(entry, request);
      void request
        .then((result) => {
          if (
            mounted &&
            refreshes.get(entry) === request &&
            context.gateway.snapshot.client === client &&
            gatewayPresentationScope(context.gateway).key === scope &&
            props.sessionKey === sessionKey &&
            props.agentId === agentId &&
            readMcpAppContexts(client, sessionKey, agentId).includes(entry)
          ) {
            publishMcpAppContext(client, { ...entry, state: result.state });
          }
        })
        // A failed refresh does not revoke the accepted context.
        .catch(() => {});
    });
    return () => {
      mounted = false;
      stop();
    };
  });
  const presentRemoval = action(function* (
    viewId: string,
    current: () => boolean,
    result: Promise<void>,
  ) {
    if (current()) {
      setPending((value) => {
        value[viewId] = current;
      });
    }
    yield result;
  });
  async function removeItem(entry: McpAppContextEntry, index?: number) {
    const client = context.gateway.snapshot.client;
    const snapshot = entry.state;
    if (!client || !snapshot || context.gateway.snapshot.phase !== "connected") {
      return;
    }
    const scope = gatewayPresentationScope(context.gateway).key;
    const sessionKey = props.sessionKey;
    const agentId = props.agentId;
    const current = () => {
      gateway.read();
      return (
        mounted &&
        context.gateway.snapshot.client === client &&
        gatewayPresentationScope(context.gateway).key === scope &&
        props.sessionKey === sessionKey &&
        props.agentId === agentId
      );
    };
    const complete = (async () => {
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
        if (current()) {
          const rendered = readMcpAppContexts(client, sessionKey, agentId).find(
            (item) => item.viewId === entry.viewId,
          );
          if (rendered?.state?.updateId === snapshot.updateId) {
            publishMcpAppContext(client, { ...entry, state: result.state });
          }
        }
      } catch (failure) {
        if (current()) {
          throw failure;
        }
      }
    })();
    const result = complete.then(() => null);
    // Detached strips still consume their admitted operation's late failure.
    void result.catch(() => {});
    setRemoval({ current, result });
    await Promise.resolve();
    if (!current()) {
      return complete;
    }
    // The alert reads the operation outcome independently of the optimistic flag.
    return presentRemoval(entry.viewId, current, complete).catch(() => {});
  }
  return (
    <openclaw-mcp-app-context-strip>
      <Show when={contexts().read().length}>
        <section class="mcp-app-context" aria-label={t("mcpApp.contextTitle")}>
          <div class="mcp-app-context__header" title={t("mcpApp.contextDescription")}>
            <Icon name="puzzle" /> {t("mcpApp.contextTitle")}
          </div>
          <For each={contexts().read()}>
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
                          disabled={pending[entry.viewId]?.()}
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
                      disabled={pending[entry.viewId]?.()}
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
          <Show when={currentRemoval()} keyed>
            {(admitted) => <McpAppOperationError result={admitted.result} />}
          </Show>
        </section>
      </Show>
    </openclaw-mcp-app-context-strip>
  );
}
