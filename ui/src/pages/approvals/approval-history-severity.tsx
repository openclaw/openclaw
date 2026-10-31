import { Show } from "solid-js";
import type {
  PluginApprovalSeverity,
  TerminalApprovalSnapshot,
} from "../../../../packages/gateway-protocol/src/schema/approvals.js";
import { t } from "../../lib/reactive/i18n.ts";

const APPROVAL_SEVERITY_LABELS = {
  info: "approvalHistory.severities.info",
  warning: "approvalHistory.severities.warning",
  critical: "approvalHistory.severities.critical",
} satisfies Record<PluginApprovalSeverity, string>;

export function ApprovalHistorySeverity(props: { item: TerminalApprovalSnapshot }) {
  const severity = () =>
    props.item.presentation.kind === "plugin" ? props.item.presentation.severity : null;
  return (
    <Show when={severity()}>
      {(value) => (
        <span class={["approval-history__severity", `approval-history__severity--${value()}`]}>
          {t(APPROVAL_SEVERITY_LABELS[value()])}
        </span>
      )}
    </Show>
  );
}
