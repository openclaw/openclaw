import { createSignal } from "solid-js";
import type { ApprovalPresentation } from "../../../../packages/gateway-protocol/src/approval-result-validators.js";
import type {
  ApprovalAllowDecision,
  ApprovalKind,
  ApprovalTerminalReason,
  TerminalApprovalSnapshot,
} from "../../../../packages/gateway-protocol/src/schema/approvals.js";
import { execWarningText } from "../../app/approval-presentation.ts";
import { Icon } from "../../components/solid/icon.tsx";
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

const APPROVAL_ALLOW_LABELS = {
  "allow-once": "approvalHistory.decisions.allowOnce",
  "allow-always": "approvalHistory.decisions.allowAlways",
} satisfies Record<ApprovalAllowDecision, string>;

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

function statusLabel(item: TerminalApprovalSnapshot) {
  // Only an allowed approval has more to say than its status.
  return item.status === "allowed" ? (
    <>
      <span class="approval-log__allowed">{t(APPROVAL_STATUS_LABELS.allowed)} · </span>
      {t(APPROVAL_ALLOW_LABELS[item.decision])}
    </>
  ) : (
    t(APPROVAL_STATUS_LABELS[item.status])
  );
}

function resolverLabel(item: TerminalApprovalSnapshot): string | undefined {
  const resolver = item.resolver;
  if (!resolver) {
    return undefined;
  }
  return resolver.id ? `${resolver.id} (${resolver.kind})` : resolver.kind;
}

function DetailRow(props: { label: string; value: string | undefined; mono?: boolean }) {
  return props.value ? (
    <div>
      <dt>{t(props.label)}</dt>
      <dd class={{ mono: props.mono }}>{props.value}</dd>
    </div>
  ) : null;
}

function ExecWarning(props: { presentation: ApprovalPresentation }) {
  const warning = () => execWarningText(props.presentation);
  return warning() ? (
    <span class="approval-history-warning" role="note">
      {t("approvalHistory.warningLabel")}: {warning()}
    </span>
  ) : null;
}

export function HistoryRow(props: {
  item: TerminalApprovalSnapshot;
  time: string;
  fullTime: string;
}) {
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  const detailsId = () => `approval-log-details-${props.item.id}`;
  return (
    <li class="approval-log__row">
      <button
        type="button"
        class="approval-log__summary"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={open() ? detailsId() : undefined}
        onClick={(event) => {
          // Selecting the open request's text must not close it.
          const selection = getSelection();
          if (
            selection?.isCollapsed === false &&
            event.currentTarget.contains(selection.anchorNode)
          ) {
            return;
          }
          setOpen((value) => !value);
        }}
      >
        <span class="approval-log__request-wrap">
          <span class="mono approval-log__request">{requestLabel(props.item)}</span>
          <ExecWarning presentation={props.item.presentation} />
        </span>
        <span class="approval-log__meta">
          <SettingsStatus
            kind={APPROVAL_STATUS_KINDS[props.item.status]}
            dot
            label={statusLabel(props.item)}
          />
          <time title={props.fullTime}>{props.time}</time>
        </span>
        <span class="approval-log__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </button>
      {open() ? (
        <div id={detailsId()} class="approval-log__details">
          <dl>
            <DetailRow
              label="approvalHistory.fields.kind"
              value={t(APPROVAL_KIND_LABELS[props.item.presentation.kind])}
            />
            <DetailRow label="approvalHistory.fields.source" value={props.item.source?.agentId} />
            <DetailRow
              label="approvalHistory.fields.session"
              value={props.item.source?.sessionKey}
              mono
            />
            <DetailRow label="approvalHistory.fields.resolver" value={resolverLabel(props.item)} />
            <DetailRow
              label="approvalHistory.fields.reason"
              value={t(APPROVAL_REASON_LABELS[props.item.reason])}
            />
          </dl>
        </div>
      ) : null}
    </li>
  );
}
