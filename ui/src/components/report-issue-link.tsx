import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { REPORT_BUG_URL } from "../lib/product-links.ts";
import { t } from "../lib/reactive/i18n.ts";

export function ReportIssueLink() {
  return (
    <a
      class="session-link"
      href={REPORT_BUG_URL}
      target={EXTERNAL_LINK_TARGET}
      rel={buildExternalLinkRel()}
      referrerpolicy="no-referrer"
      title={t("common.reportIssuePrivacy")}
    >
      {t("common.reportBug")}
    </a>
  );
}
