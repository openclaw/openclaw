import { createMemo, Errored, lazy, Loading, Show } from "solid-js";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../lib/format-error.ts";
import { createMcpAppCatalog } from "../lib/mcp-app-catalog.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import "../styles/mcp-app-extensions.css";

registerMcpAppEnglish();
const ResourcesView = lazy(() => import("./mcp-app-resources-view.tsx"), {
  export: "McpAppResourcesView",
});
type McpAppResourcesProps = { sessionKey: string; agentId: string };
export function McpAppResources(props: McpAppResourcesProps) {
  let host!: HTMLElement;
  const context = useApplication();
  const catalog = createMcpAppCatalog(context, () => ({
    sessionKey: props.sessionKey,
    agentId: props.agentId,
  }));
  const visible = createMemo(() => catalog.snapshot().servers.some((server) => server.mentionTool));
  // Discovery may temporarily hide this picker; keep its query and expansion.
  const revealed = createMemo((previous = false) => previous || visible());
  return (
    <openclaw-mcp-app-resources ref={(element) => (host = element)}>
      <Show when={revealed()}>
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
            <ResourcesView {...props} catalog={catalog} host={() => host} />
          </Loading>
        </Errored>
      </Show>
    </openclaw-mcp-app-resources>
  );
}
