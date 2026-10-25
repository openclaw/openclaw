import { createMemo, Errored, lazy, Loading, Show } from "solid-js";
import type { McpAppDiscoveredServer } from "../../../src/shared/mcp-app-extensions.js";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { formatUiError } from "../lib/format-error.ts";
import { createMcpAppCatalog } from "../lib/mcp-app-catalog.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import "../styles/mcp-app-extensions.css";

registerMcpAppEnglish();
const CatalogView = lazy(() => import("./mcp-app-catalog-view.tsx"), {
  export: "McpAppCatalogView",
});
type McpAppCatalogProps = {
  sessionKey?: string;
  agentId?: string;
  surface?: "global" | "thread" | "sidebar" | "file";
  filePath?: string;
};
export function McpAppCatalog(props: McpAppCatalogProps) {
  let host!: HTMLElement;
  const context = useApplication();
  const surface = () => props.surface ?? "global";
  const catalog = createMcpAppCatalog(
    context,
    () => ({
      sessionKey: props.sessionKey || context.gateway.snapshot.sessionKey || "",
      agentId: props.agentId || context.agentSelection.state.selectedId || undefined,
    }),
    () => surface() === "global",
  );
  const entries = (server: McpAppDiscoveredServer) =>
    server.entrypoints.filter(({ entrypoint }) =>
      surface() === "file"
        ? entrypoint.type === "file" &&
          entrypoint.extensions.some((extension) =>
            (props.filePath ?? "").toLowerCase().endsWith(extension.toLowerCase()),
          )
        : entrypoint.type === (surface() === "sidebar" ? "global" : surface()),
    );
  const rows = createMemo(() =>
    catalog
      .snapshot()
      .servers.flatMap((server) => entries(server).map((entry) => ({ server, entry }))),
  );
  const visible = () =>
    catalog.visible() &&
    !(surface() === "file" && !rows().length) &&
    !(
      surface() === "thread" &&
      !rows().length &&
      !catalog.snapshot().onboarding.length &&
      !catalog.snapshot().servers.some((server) => server.settings)
    );
  // Once opened, retain interaction state through temporarily empty discovery.
  const revealed = createMemo((previous = false) => previous || visible());
  return (
    <openclaw-mcp-app-catalog
      ref={(element) => (host = element)}
      surface={surface() === "global" ? undefined : surface()}
    >
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
            <CatalogView
              {...props}
              host={() => host}
              catalog={catalog}
              rows={rows()}
              entries={entries}
              visible={visible()}
            />
          </Loading>
        </Errored>
      </Show>
    </openclaw-mcp-app-catalog>
  );
}
