import type { RouteLocation } from "@openclaw/uirouter";
import { For, createMemo } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../components/solid/panel-empty-state.tsx";
import { TerminalPanelHost } from "../../components/terminal/terminal-panel-registration.ts";
import {
  projectAgentSelection,
  projectApplicationConfig,
  projectGateway,
} from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectTheme } from "../../lib/reactive/theme.ts";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { isTerminalAvailable } from "../../lib/terminal-availability.ts";
import { resolveTerminalRouteLocation } from "./route-location.ts";
import "./terminal-page.css";

export function TerminalPageContent(props: { location: RouteLocation | null }) {
  const context = useApplication();
  const gateway = projectGateway(context.gateway);
  const config = projectApplicationConfig(context.config);
  const selection = projectAgentSelection(context.agentSelection);
  const theme = projectTheme(context.theme);
  const snapshot = () => gateway.read().snapshot;
  const available = () => isTerminalAvailable(snapshot(), config.read().terminalEnabled ?? false);
  const owner = () => selection.read().state.selectedId ?? snapshot().assistantAgentId;
  const target = createMemo(() =>
    props.location ? resolveTerminalRouteLocation(props.location, context.basePath) : null,
  );
  const route = createMemo(() => {
    const current = target();
    const key = current
      ? "sessionId" in current
        ? current.sessionId
        : buildCatalogSessionKey(current.catalog)
      : "";
    return [{ target: current, key }];
  });
  const themeMode = () => {
    theme.appliedPalette.read();
    return context.theme.resolvedMode;
  };
  return (
    <For each={route()} keyed={(entry) => entry.key}>
      {(entry) => (
        <>
          <TerminalPanelHost
            hidden={!available()}
            embedded
            fullscreen
            page={true}
            routeTarget={entry().target}
            client={snapshot().phase === "connected" ? snapshot().client : null}
            available={available()}
            agentId={owner() ? normalizeAgentId(owner()!) : null}
            basePath={context.basePath}
            themeMode={themeMode()}
          />
          {!available() && (
            <PanelEmptyState
              heading={t("terminal.title")}
              description={t("terminal.unavailable")}
              icon={<Icon name="terminal" />}
              action={
                <button class="btn" onClick={() => context.navigate("new-session")}>
                  {t("newSession.title")}
                </button>
              }
            />
          )}
        </>
      )}
    </For>
  );
}
