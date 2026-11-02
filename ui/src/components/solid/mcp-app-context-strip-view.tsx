import { action, createOptimisticStore, createSignal, For, onSettled, Show } from "solid-js";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import {
  readMcpAppContexts,
  publishMcpAppContext,
  mcpAppContextItemTitle,
  mcpAppContextThumbnail,
  type McpAppContextEntry,
  type McpAppContextState,
} from "../../lib/mcp-app-context.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { Icon } from "./icon.tsx";
import { McpAppOperationError } from "./mcp-app-operation-error.tsx";

type McpAppContextStripProps = { sessionKey: string; agentId: string };

export function McpAppContextStripView(
  props: McpAppContextStripProps & { entries: readonly McpAppContextEntry[] },
) {
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
  let mounted = false;
  onSettled(() => {
    mounted = true;
    return () => {
      mounted = false;
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
    <section class="mcp-app-context" aria-label={t("mcpApp.contextTitle")}>
      <div class="mcp-app-context__header" title={t("mcpApp.contextDescription")}>
        <Icon name="puzzle" /> {t("mcpApp.contextTitle")}
      </div>
      <For each={props.entries}>
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
                const title = () => mcpAppContextItemTitle(content, `${entry.title} · ${t(kind)}`);
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
  );
}
