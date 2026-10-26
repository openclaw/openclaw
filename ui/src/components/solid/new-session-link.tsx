import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveNewSessionShortcut } from "../../lib/keyboard-shortcut-contract.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { newSessionSearch, type NewSessionTarget } from "../../pages/new-session/location.ts";
import { Icon } from "./icon.tsx";
import { ShortcutHint } from "./kbd.tsx";
import "../tooltip.ts";

export function renderNewSessionLink(params: {
  basePath: string;
  agentId: string;
  target?: NewSessionTarget;
  class: string;
  label: string;
  disabledReason?: string;
  showShortcut?: boolean;
  showTooltip?: boolean;
  onOpen?: (agentId: string, target?: NewSessionTarget) => void;
}): JSX.Element {
  const disabled = () => Boolean(params.disabledReason);
  const href = () =>
    `${pathForRoute("new-session", params.basePath)}${newSessionSearch(params.agentId, params.target)}`;
  const link = (
    <a
      class={params.class}
      role="link"
      href={disabled() ? undefined : href()}
      aria-label={params.label}
      aria-disabled={disabled() ? "true" : undefined}
      tabindex={disabled() ? -1 : undefined}
      onContextMenu={(event: MouseEvent) => {
        // Section menus must not replace the browser's Open Link in New Tab actions.
        event.stopPropagation();
      }}
      onClick={(event: MouseEvent) => {
        if (disabled()) {
          event.preventDefault();
          return;
        }
        if (params.onOpen) {
          handleNavigationClick(event, () => params.onOpen?.(params.agentId, params.target));
        }
      }}
    >
      <Icon name="plus" />
    </a>
  );
  return params.showTooltip === false ? (
    link
  ) : (
    <openclaw-tooltip
      prop:content={params.disabledReason ?? (params.showShortcut ? undefined : params.label)}
    >
      <Show when={params.disabledReason == null && params.showShortcut}>
        <span slot="content">
          <ShortcutHint label={params.label} combo={resolveNewSessionShortcut()} />
        </span>
      </Show>
      {link}
    </openclaw-tooltip>
  );
}

const NewSessionLink = renderNewSessionLink;

export function ContextNewSessionAction(props: {
  context: ApplicationContext;
  class: string;
  agentId?: string;
  label?: string;
  showTooltip?: boolean;
}) {
  const agentId = () =>
    props.agentId ??
    normalizeAgentId(
      props.context.agentSelection.state.selectedId ??
        props.context.gateway.snapshot.assistantAgentId,
    );
  const readAccess = () =>
    readSessionMethodAccess(props.context.gateway.snapshot, {
      method: "sessions.create",
      params: {},
      sessionScope: true,
    });
  const access = createMemo(readAccess);
  const disabledReason = () => {
    const current = access();
    return current.allowed ? undefined : current.reason;
  };
  const onOpen = (id: string) => {
    if (readAccess().allowed) {
      props.context.navigate("new-session", { search: newSessionSearch(id) });
    }
  };
  return (
    <NewSessionLink
      basePath={props.context.basePath}
      agentId={agentId()}
      class={props.class}
      label={props.label ?? t("agentChip.newConversation")}
      showShortcut
      showTooltip={props.showTooltip}
      disabledReason={disabledReason()}
      onOpen={onOpen}
    />
  );
}
