import type { ScopeUpgradeState } from "../app/device-scope-upgrade-availability.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";

registerEnglishCatalog(registerSidebarAttentionEnglish);

export function scopeUpgradeText(state: Exclude<ScopeUpgradeState, { phase: "hidden" }>): string {
  switch (state.phase) {
    case "guidance":
      return t(
        state.reason === "role"
          ? "connection.scopeUpgrade.roleGuidance"
          : "connection.scopeUpgrade.guidance",
      );
    case "available":
      return t("profilePage.access.adminRequestHint");
    case "requesting":
      return t("connection.scopeUpgrade.requesting");
    case "pending":
      return t("connection.scopeUpgrade.pending", {
        command: `openclaw devices approve ${state.requestId}`,
      });
    case "rejected":
      return t(
        state.expired ? "connection.scopeUpgrade.expired" : "connection.scopeUpgrade.rejected",
      );
    case "error":
      return t("connection.scopeUpgrade.error", { error: state.message });
  }
  return state satisfies never;
}

export function ScopeUpgradeActions(props: {
  state: Exclude<ScopeUpgradeState, { phase: "hidden" }>;
  onRequest: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const retryable = () =>
    props.state.phase === "error"
      ? props.state.retryable
      : props.state.phase === "pending" || props.state.phase === "rejected";
  return (
    <>
      {props.state.phase === "available" || props.state.phase === "requesting" ? (
        <button
          type="button"
          class="btn primary"
          disabled={props.state.phase === "requesting"}
          onClick={() => props.onRequest()}
        >
          {t(
            props.state.phase === "available"
              ? "connection.scopeUpgrade.request"
              : "connection.scopeUpgrade.requestingAction",
          )}
        </button>
      ) : retryable() || props.state.phase === "error" ? (
        <>
          {retryable() ? (
            <button type="button" class="btn primary" onClick={() => props.onRetry()}>
              {t("connection.scopeUpgrade.retry")}
            </button>
          ) : null}
          <button type="button" class="btn" onClick={() => props.onCancel()}>
            {t("connection.scopeUpgrade.cancel")}
          </button>
        </>
      ) : null}
    </>
  );
}
