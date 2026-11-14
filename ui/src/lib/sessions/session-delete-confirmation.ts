import { isIncognitoSessionKey } from "../../../../src/shared/incognito-session-key.js";
import { t } from "../../i18n/index.ts";
import { registerSessionOrganizationEnglish } from "../../i18n/locales/en-session-organization.ts";

registerSessionOrganizationEnglish();

/** Match the Gateway's transcript-retention distinction without changing deletion authority. */
export function sessionDeleteConfirmationMessage(
  sessions: readonly { key: string; incognito?: boolean }[],
): string {
  const incognitoCount = sessions.filter(
    (session) => session.incognito === true || isIncognitoSessionKey(session.key),
  ).length;
  if (sessions.length === 1) {
    return t(
      incognitoCount
        ? "sessionsView.deleteIncognitoSessionConfirm"
        : "sessionsView.deleteSessionConfirm",
    );
  }
  return t(
    incognitoCount === 0
      ? "sessionsView.deleteSessionsConfirm"
      : incognitoCount === sessions.length
        ? "sessionsView.deleteIncognitoSessionsConfirm"
        : "sessionsView.deleteMixedSessionsConfirm",
  );
}
