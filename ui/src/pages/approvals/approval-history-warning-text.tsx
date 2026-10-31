import { Show } from "solid-js";
import type { TerminalApprovalSnapshot } from "../../../../packages/gateway-protocol/src/schema/approvals.js";
import { t } from "../../lib/reactive/i18n.ts";

export function ApprovalHistoryWarningText(props: { item: TerminalApprovalSnapshot }) {
  const warningText = () =>
    props.item.presentation.kind === "exec"
      ? props.item.presentation.warningText?.trim() || null
      : null;
  return (
    <Show when={warningText()}>
      {(value) => <div class="approval-history__warning-text">{value()}</div>}
    </Show>
  );
}
