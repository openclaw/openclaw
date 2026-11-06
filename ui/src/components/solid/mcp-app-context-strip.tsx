import { createMemo, Errored, lazy, Loading, onSettled, Show } from "solid-js";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { registerMcpAppEnglish } from "../../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  readMcpAppContexts,
  publishMcpAppContext,
  subscribeMcpAppContexts,
  type McpAppContextEntry,
  type McpAppContextState,
} from "../../lib/mcp-app-context.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import "../../styles/mcp-app-extensions.css";

registerMcpAppEnglish();
const ContextView = lazy(() => import("./mcp-app-context-strip-view.tsx"), {
  export: "McpAppContextStripView",
});
type McpAppContextStripProps = { sessionKey: string; agentId: string };
export function McpAppContextStrip(props: McpAppContextStripProps) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
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
  return (
    <openclaw-mcp-app-context-strip>
      <Show when={contexts().read().length}>
        <Errored
          fallback={(error, retry) => (
            <p role="alert">
              {formatUiError(error())}
              <button class="btn btn--sm" onClick={retry}>
                {t("common.retry")}
              </button>
            </p>
          )}
        >
          <Loading fallback={<p role="status">{t("mcpApp.loading")}</p>}>
            <ContextView {...props} entries={contexts().read()} />
          </Loading>
        </Errored>
      </Show>
    </openclaw-mcp-app-context-strip>
  );
}
