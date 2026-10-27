import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionOrganizationSharedEnglish } from "../../i18n/locales/en-session-organization-shared.ts";
import { formatUiError } from "../format-error.ts";
import { readSessionMethodAccess } from "../session-method-access.ts";
import { showToast } from "../toast.ts";
import { resolveUiSessionRowAgentId } from "./session-key.ts";

registerSessionOrganizationSharedEnglish();

// A rejection toast outlives its hovercard; a later successful acknowledgement replaces it.
let rejectionToast: object | undefined;

/** The failed session to acknowledge; callers decide that its failure is still an alert. */
type SessionFailureTarget = Pick<GatewaySessionRow, "key"> &
  Partial<Pick<GatewaySessionRow, "agentId" | "sessionId" | "markedUnreadAt" | "sharingRole">>;

/** Viewers and callers without patch access keep the alert; it still clears when they open it. */
export function canDismissSessionFailure(
  context: Pick<ApplicationContext, "gateway">,
  target: SessionFailureTarget,
  fallbackAgentId = "main",
): boolean {
  return (
    target.sharingRole !== "viewer" &&
    readSessionMethodAccess(context.gateway.snapshot, {
      method: "sessions.patch",
      params: {
        key: target.key,
        unread: false,
        agentId: resolveUiSessionRowAgentId(target, fallbackAgentId),
      },
      sessionScope: true,
      session: target,
    }).allowed
  );
}

/**
 * Dismissing a failure writes the same Gateway read receipt that opening the session does,
 * so every surface and device hides it and a later failure of the same session shows again.
 * The alert stays until the Gateway row reports the read. A rejected write keeps the alert and
 * its control for a retry, and a toast says why, since a hovercard may already have closed.
 */
export async function dismissSessionFailures(
  context: Pick<ApplicationContext, "gateway" | "sessions">,
  targets: readonly SessionFailureTarget[],
  fallbackAgentId = "main",
): Promise<void> {
  const results = await Promise.allSettled(
    targets
      .filter((target) => canDismissSessionFailure(context, target, fallbackAgentId))
      .map((target) =>
        context.sessions.patch(
          target.key,
          { unread: false },
          {
            agentId: resolveUiSessionRowAgentId(target, fallbackAgentId),
            expectedMarkedUnreadAt: target.markedUnreadAt ?? null,
            ...(target.sessionId ? { expectedSessionId: target.sessionId } : {}),
          },
        ),
      ),
  );
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) {
    const toast = {};
    rejectionToast = toast;
    showToast({
      message: t("sessionsView.markFailureReadFailed", { error: formatUiError(rejected.reason) }),
      severity: "error",
      onDismiss: () => {
        if (rejectionToast === toast) {
          rejectionToast = undefined;
        }
      },
    });
  } else if (rejectionToast && results.length > 0) {
    rejectionToast = undefined;
    showToast({ message: t("sessionsView.markFailureReadDone") });
  }
}
