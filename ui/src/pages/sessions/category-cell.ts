import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";

type CategoryCellProps = {
  loading: boolean;
  knownCategories: string[];
  groupWriteDisabledReason?: string;
  onAssignCategory: (key: string, category: string | null) => void;
  onRequestNewCategory: (sessionKey?: string) => void;
};

const NEW_GROUP_OPTION = "__new-group__";

export function renderCategoryCell(row: GatewaySessionRow, props: CategoryCellProps) {
  const current = normalizeOptionalString(row.category) ?? "";
  const options = [...props.knownCategories];
  if (current && !options.includes(current)) {
    options.push(current);
  }
  return html`
    <td>
      <select
        ?disabled=${props.loading || Boolean(props.groupWriteDisabledReason)}
        title=${props.groupWriteDisabledReason ?? nothing}
        aria-label=${t("sessionsView.moveToGroup")}
        class="session-group-select"
        @change=${(e: Event) => {
          if (props.groupWriteDisabledReason) {
            return;
          }
          const select = e.currentTarget;
          if (!(select instanceof HTMLSelectElement)) {
            return;
          }
          if (select.value === NEW_GROUP_OPTION) {
            // The page prompts for a name and patches; restore until the refresh lands.
            select.value = current;
            props.onRequestNewCategory(row.key);
            return;
          }
          props.onAssignCategory(row.key, select.value || null);
        }}
      >
        <option value="" ?selected=${!current}>${t("sessionsView.ungrouped")}</option>
        ${options.map(
          (name) => html`<option value=${name} ?selected=${current === name}>${name}</option>`,
        )}
        <option value=${NEW_GROUP_OPTION}>${t("sessionsView.newGroup")}</option>
      </select>
    </td>
  `;
}
