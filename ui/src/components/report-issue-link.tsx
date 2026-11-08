import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { REPORT_BUG_URL } from "../lib/product-links.ts";
import { t } from "../lib/reactive/i18n.ts";
import { Icon } from "./solid/icon.tsx";

export function ReportIssueLink() {
  return (
    <a
      class="session-link"
      style={{ display: "inline-flex", "align-items": "center", gap: "4px" }}
      href={REPORT_BUG_URL}
      target={EXTERNAL_LINK_TARGET}
      rel={buildExternalLinkRel()}
      referrerpolicy="no-referrer"
      title={t("common.reportIssuePrivacy")}
    >
      <Icon name="bug" style={{ width: "14px", height: "14px", "flex-shrink": 0 }} />
      {t("common.reportBug")}
    </a>
  );
}
