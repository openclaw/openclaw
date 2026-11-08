import type { ExecApprovalStandingGrant } from "../../../../packages/gateway-protocol/src/schema/exec-approvals.js";
import { t } from "../../lib/reactive/i18n.ts";

function grantStateLabel(grant: ExecApprovalStandingGrant, nowMs: number): string {
  if (grant.revokedAtMs !== null) {
    return t("standingGrants.stateRevoked");
  }
  if (grant.expiresAtMs !== null && grant.expiresAtMs <= nowMs) {
    return t("standingGrants.stateExpired");
  }
  if (grant.expiresAtMs !== null) {
    const days = Math.max(1, Math.ceil((grant.expiresAtMs - nowMs) / 86_400_000));
    return t("standingGrants.stateExpiresIn", { count: String(days) });
  }
  return t("standingGrants.stateUntilRevoked");
}

export function GrantRow(props: {
  grant: ExecApprovalStandingGrant;
  revoking: boolean;
  disabled: boolean;
  onRevoke: () => void;
}) {
  const revokeLabel = () => t(props.revoking ? "standingGrants.revoking" : "standingGrants.revoke");
  return (
    <li class="standing-grants__row">
      <span class="standing-grants__automation">
        {props.grant.cronJobName ?? props.grant.cronJobId}
      </span>
      <code class="mono standing-grants__command">{props.grant.command}</code>
      <span class="standing-grants__meta">
        <span>
          {t("standingGrants.columns.uses")} {props.grant.useCount}
        </span>
        <span aria-live="polite">{grantStateLabel(props.grant, Date.now())}</span>
      </span>
      {props.grant.revokedAtMs === null &&
      (props.grant.expiresAtMs === null || props.grant.expiresAtMs > Date.now()) ? (
        <button
          class="btn btn--sm standing-grants__revoke"
          aria-label={`${revokeLabel()}: ${props.grant.cronJobName ?? props.grant.cronJobId} — ${props.grant.command}`}
          disabled={props.disabled}
          onClick={props.onRevoke}
        >
          {revokeLabel()}
        </button>
      ) : null}
    </li>
  );
}
