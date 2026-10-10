import type { RouteLocation } from "@openclaw/uirouter";
import { For, createMemo } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import "../../components/panel-empty-state.ts";
import "../../components/terminal/terminal-panel-registration.ts";
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
          <openclaw-terminal-panel
            hidden={!available()}
            embedded
            fullscreen
            prop:page={true}
            prop:routeTarget={entry().target}
            prop:client={snapshot().phase === "connected" ? snapshot().client : null}
            prop:available={available()}
            prop:agentId={owner() ? normalizeAgentId(owner()!) : null}
            prop:basePath={context.basePath}
            prop:themeMode={themeMode()}
          />
          {!available() && (
            <openclaw-panel-empty-state
              prop:heading={t("terminal.title")}
              prop:description={t("terminal.unavailable")}
            >
              <Icon name="terminal" />
              <span slot="action">
                <button class="btn" onClick={() => context.navigate("new-session")}>
                  {t("newSession.title")}
                </button>
              </span>
            </openclaw-panel-empty-state>
          )}
        </>
      )}
    </For>
  );
}
