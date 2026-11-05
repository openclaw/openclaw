import type { ScopeUpgradeState } from "../app/device-scope-upgrade-availability.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { sidebarAttentionFocusRef } from "./sidebar-attention-focus.ts";

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
      return t("connection.scopeUpgrade.limited");
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
  inbox?: boolean;
  onRequest: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const retryable = () =>
    props.state.phase === "error"
      ? props.state.retryable
      : props.state.phase === "pending" || props.state.phase === "rejected";
  const primaryClass = () =>
    props.inbox
      ? "sidebar-issues-panel__action sidebar-issues-panel__action--primary"
      : "btn primary";
  return (
    <>
      {props.state.phase === "available" || props.state.phase === "requesting" ? (
        <button
          ref={sidebarAttentionFocusRef()}
          type="button"
          class={primaryClass()}
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
            <button
              ref={sidebarAttentionFocusRef()}
              type="button"
              class={primaryClass()}
              onClick={() => props.onRetry()}
            >
              {t("connection.scopeUpgrade.retry")}
            </button>
          ) : null}
          <button
            ref={sidebarAttentionFocusRef()}
            type="button"
            class={props.inbox ? "sidebar-issues-panel__action" : "btn"}
            onClick={() => props.onCancel()}
          >
            {t("connection.scopeUpgrade.cancel")}
          </button>
        </>
      ) : null}
    </>
  );
}
