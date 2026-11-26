import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { REPORT_BUG_URL } from "../lib/issue-links.ts";
import { t } from "../lib/reactive/i18n.ts";
import { sessionIcon } from "./solid/icon.tsx";

export function ReportIssueLink() {
  return (
    <a
      class="session-link report-issue-link"
      href={REPORT_BUG_URL}
      target={EXTERNAL_LINK_TARGET}
      rel={buildExternalLinkRel()}
      referrerpolicy="no-referrer"
    >
      {sessionIcon("bug", 14)}
      {t("common.reportBug")}
    </a>
  );
}
