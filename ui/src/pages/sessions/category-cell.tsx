import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createMemo, For } from "solid-js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { registerSessionOrganizationEnglish } from "../../i18n/locales/en-session-organization.ts";
import { t } from "../../lib/reactive/i18n.ts";

registerSessionOrganizationEnglish();

type CategoryCellProps = {
  loading: boolean;
  knownCategories: string[];
  groupWriteDisabledReason?: string;
  onAssignCategory: (key: string, category: string | null) => void;
  onRequestNewCategory: (sessionKey?: string) => void;
};

export function CategoryCell(props: CategoryCellProps & { row: GatewaySessionRow }) {
  const current = createMemo(() => normalizeOptionalString(props.row.category) ?? "");
  const options = createMemo(() =>
    current() && !props.knownCategories.includes(current())
      ? [...props.knownCategories, current()]
      : props.knownCategories,
  );
  return (
    <td>
      <select
        disabled={props.loading || Boolean(props.groupWriteDisabledReason)}
        title={props.groupWriteDisabledReason ?? undefined}
        aria-label={t("sessionsView.moveToGroup")}
        class="session-group-select"
        onChange={(e) => {
          if (props.groupWriteDisabledReason) {
            return;
          }
          const select = e.currentTarget;
          if (select.options[select.selectedIndex]?.dataset.action === "create") {
            // The page prompts for a name and patches; restore until the refresh lands.
            select.value = current();
            props.onRequestNewCategory(props.row.key);
            return;
          }
          const picked = select.value;
          // Same contract as the create branch: a pick is a request, so restore the stored
          // group until the owner publishes a confirmed one. A rejected patch must not leave
          // the control showing the group the gateway refused.
          select.value = current();
          props.onAssignCategory(props.row.key, picked || null);
        }}
      >
        <option value="" selected={!current()}>
          {t("sessionsView.ungrouped")}
        </option>
        <For each={options()}>
          {(name) => (
            <option value={name} selected={current() === name}>
              {name}
            </option>
          )}
        </For>
        <option data-action="create">{t("sessionsView.newGroup")}</option>
      </select>
    </td>
  );
}
