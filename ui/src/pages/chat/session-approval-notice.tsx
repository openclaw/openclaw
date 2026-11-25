import { Show, createMemo } from "solid-js";
import { readApprovalTime } from "../../components/approval-countdown.tsx";
import { registerApprovalsEnglish } from "../../i18n/locales/en-approvals.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { ParticipantApprovalNotice } from "./session-approval-projection.ts";

registerEnglishCatalog(registerApprovalsEnglish);

export function SessionApprovalNotice(props: { approval: ParticipantApprovalNotice | null }) {
  const pending = createMemo(() => {
    const approval = props.approval;
    return approval && approval.expiresAtMs > readApprovalTime(approval.expiresAtMs);
  });
  return (
    <Show when={pending()}>
      <div class="exec-approval-warning" role="status">
        {t("execApproval.participantWaiting")}
      </div>
    </Show>
  );
}
