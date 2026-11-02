import type { JSX } from "@solidjs/web";
import { Icon } from "../../components/solid/icon.tsx";
import { PhoneSheet } from "../../components/solid/phone-sheet.tsx";
import { t } from "../../lib/reactive/i18n.ts";

export function UsageFilterSheet(props: { active: boolean; children: JSX.Element }) {
  return (
    <PhoneSheet
      id="usage-filter-sheet"
      label={t("usage.filters.title")}
      class="usage-filter-sheet"
      triggerClass={["btn btn--sm usage-filter-sheet__trigger", { active: props.active }]}
      triggerTitle={t("usage.filters.title")}
      trigger={<Icon name="listFilter" />}
    >
      {props.children}
    </PhoneSheet>
  );
}
