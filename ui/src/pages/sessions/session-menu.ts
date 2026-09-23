import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html } from "lit";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { sessionMenuReasons } from "../../components/session-menu-access.ts";
import type { SessionMenuAction, SessionMenuWork } from "../../components/session-menu.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import {
  canArchiveSessionRow,
  canDeleteSessionRows,
  isPinnableUiSessionRow,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { canCopySessionMarkdown } from "../../lib/sessions/session-menu-navigation.ts";
import { pluginSessionMenuActions } from "../../plugins/control-ui-actions.ts";

export function renderSessionManagementMenu(params: {
  context: ApplicationContext;
  row: GatewaySessionRow;
  menu: { key: string; sessionId?: string; x: number; y: number };
  trigger: HTMLElement | null;
  disabled: boolean;
  groups: string[];
  work: SessionMenuWork | null;
  onClose: () => void;
  onAction: (action: SessionMenuAction) => void;
}) {
  const { context, row } = params;
  const gateway = context.gateway.snapshot;
  const mainKey = resolveUiConfiguredMainKey({
    agentsList: context.agents.state.agentsList,
    hello: gateway.hello,
  });
  const archiveAllowed = canArchiveSessionRow(row, mainKey);
  const deleteAllowed = canDeleteSessionRows([row], mainKey);
  const cloudWorkerStopAction = resolveCloudWorkerStopAction(row.placement);
  const cloudWorkerStopAllowed = Boolean(
    cloudWorkerStopAction &&
    (!cloudWorkerStopAction.blocksActiveRun || row.hasActiveRun !== true) &&
    isGatewayMethodAdvertised(gateway, cloudWorkerStopAction.method) === true,
  );
  const pinnable = isPinnableUiSessionRow(row);
  return html`
    <openclaw-session-menu
      .session=${{
        label: normalizeOptionalString(row.label) ?? row.key,
        sessionId: normalizeOptionalString(row.sessionId) ?? null,
        pinned: row.pinned === true,
        pinnable,
        unread: row.unread === true,
        hiddenFromInvolvingMe: row.hiddenFromInvolvingMe,
        archived: row.archived === true,
        archiving: context.sessions.archiveVisibility(row.key) === "pending",
        category: normalizeOptionalString(row.category) ?? null,
        icon: normalizeOptionalString(row.icon) ?? null,
        color: normalizeOptionalString(row.color) ?? null,
        categoryClearReturnsToGroups: false,
      }}
      .anchor=${params.menu}
      .trigger=${params.trigger}
      .disabled=${params.disabled}
      .navigationAllowed=${true}
      .copyMarkdownAllowed=${canCopySessionMarkdown(gateway)}
      .splitAllowed=${false}
      .actionDisabledReasons=${sessionMenuReasons({
        snapshot: gateway,
        session: { ...row, pinnable },
        cloudWorkerStopAction,
      })}
      .forkDisabled=${row.modelSelectionLocked === true}
      .forkFromLastCompleted=${row.hasActiveRun === true}
      .archiveAllowed=${archiveAllowed}
      .deleteAllowed=${deleteAllowed}
      .cloudWorkerStopAllowed=${cloudWorkerStopAllowed}
      .groups=${params.groups}
      .work=${params.work}
      .pluginActions=${pluginSessionMenuActions(context.plugins, row)}
      .onClose=${params.onClose}
      .onAction=${params.onAction}
    ></openclaw-session-menu>
  `;
}
