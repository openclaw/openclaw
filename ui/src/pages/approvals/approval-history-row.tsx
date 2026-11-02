import type { JSX } from "@solidjs/web";
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalTerminalReason,
  TerminalApprovalSnapshot,
} from "../../../../packages/gateway-protocol/src/schema/approvals.js";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";

const APPROVAL_KIND_LABELS = {
  exec: "approvalHistory.kinds.exec",
  plugin: "approvalHistory.kinds.plugin",
  "system-agent": "approvalHistory.kinds.systemAgent",
} satisfies Record<ApprovalKind, string>;

const APPROVAL_STATUS_LABELS = {
  allowed: "approvalHistory.statuses.allowed",
  denied: "approvalHistory.statuses.denied",
  expired: "approvalHistory.statuses.expired",
  cancelled: "approvalHistory.statuses.cancelled",
} satisfies Record<TerminalApprovalSnapshot["status"], string>;

const APPROVAL_STATUS_KINDS = {
  allowed: "ok",
  denied: "danger",
  expired: "muted",
  cancelled: "muted",
} satisfies Record<TerminalApprovalSnapshot["status"], "ok" | "danger" | "muted">;

const APPROVAL_DECISION_LABELS = {
  "allow-once": "approvalHistory.decisions.allowOnce",
  "allow-always": "approvalHistory.decisions.allowAlways",
  deny: "approvalHistory.decisions.deny",
} satisfies Record<ApprovalDecision, string>;

const APPROVAL_REASON_LABELS = {
  user: "approvalHistory.reasons.user",
  timeout: "approvalHistory.reasons.timeout",
  "malformed-verdict": "approvalHistory.reasons.malformedVerdict",
  "no-route": "approvalHistory.reasons.noRoute",
  "run-aborted": "approvalHistory.reasons.runAborted",
  "gateway-restart": "approvalHistory.reasons.gatewayRestart",
  "storage-corrupt": "approvalHistory.reasons.storageCorrupt",
} satisfies Record<ApprovalTerminalReason, string>;

function requestLabel(item: TerminalApprovalSnapshot): string {
  const presentation = item.presentation;
  const request = presentation.kind === "exec" ? presentation.commandText : presentation.title;
  return request || t("approvalHistory.unknown");
}

function sourceLabel(item: TerminalApprovalSnapshot): string {
  const parts = [item.source?.agentId, item.source?.sessionKey].filter((part): part is string =>
    Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : t("approvalHistory.unknown");
}

function resolverLabel(item: TerminalApprovalSnapshot): string {
  if (!item.resolver) {
    return t("approvalHistory.unknown");
  }
  return item.resolver.id ? `${item.resolver.kind} · ${item.resolver.id}` : item.resolver.kind;
}

export function Cell(props: {
  labelKey: string;
  value: JSX.Element;
  mono?: boolean;
  unknown?: boolean;
}) {
  return (
    <td
      class={{ mono: props.mono }}
      data-label={t(props.labelKey)}
      data-unknown={props.unknown ? "" : undefined}
    >
      {props.value}
    </td>
  );
}

export function HistoryRow(props: {
  item: TerminalApprovalSnapshot;
  formatResolvedAt: (ms: number) => string;
}) {
  return (
    <tr>
      <Cell
        labelKey="approvalHistory.columns.resolved"
        value={props.formatResolvedAt(props.item.resolvedAtMs)}
      />
      <Cell
        labelKey="approvalHistory.columns.kind"
        value={t(APPROVAL_KIND_LABELS[props.item.presentation.kind])}
      />
      <td
        class="mono approval-history__request"
        data-label={t("approvalHistory.columns.request")}
        title={requestLabel(props.item)}
      >
        {requestLabel(props.item)}
      </td>
      <td class="approval-history__decision" data-label={t("approvalHistory.columns.decision")}>
        <SettingsStatus
          kind={APPROVAL_STATUS_KINDS[props.item.status]}
          dot
          label={
            // Only an allowed approval has more to say than its status.
            props.item.status === "allowed"
              ? `${t(APPROVAL_STATUS_LABELS.allowed)} · ${t(APPROVAL_DECISION_LABELS[props.item.decision])}`
              : t(APPROVAL_STATUS_LABELS[props.item.status])
          }
        />
      </td>
      <Cell
        labelKey="approvalHistory.columns.reason"
        value={t(APPROVAL_REASON_LABELS[props.item.reason])}
      />
      <Cell
        labelKey="approvalHistory.columns.source"
        value={sourceLabel(props.item)}
        unknown={!props.item.source?.agentId && !props.item.source?.sessionKey}
        mono
      />
      <Cell
        labelKey="approvalHistory.columns.resolver"
        value={resolverLabel(props.item)}
        unknown={!props.item.resolver}
        mono
      />
    </tr>
  );
}
