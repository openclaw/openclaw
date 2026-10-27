import "./personal-session-group-dialog.css";
import { createMemo, createSignal, For, Show } from "solid-js";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import type { PersonalSessionGroup } from "../lib/sessions/personal-groups.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

registerEnglishCatalog(registerSessionOrganizationEnglish);

export type PersonalSessionGroupDialogOptions = {
  group?: PersonalSessionGroup;
  candidates: SidebarRecentSession[];
  signal: AbortSignal;
  submit: (value: Pick<PersonalSessionGroup, "label" | "sessionKeys">) => string | null;
};

export function PersonalSessionGroupDialogView(props: {
  options: PersonalSessionGroupDialogOptions;
  finish(): void;
}) {
  const [label, setLabel] = createSignal(() => props.options.group?.label ?? "");
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(
    () => new Set(props.options.group?.sessionKeys),
  );
  const [error, setError] = createSignal<string | null>(null);
  const rows = createMemo(() =>
    props.options.candidates.filter((row) =>
      row.label.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase()),
    ),
  );
  const title = () =>
    t(props.options.group ? "sessionsView.personalGroupEdit" : "sessionsView.personalGroupNew");
  let nameInput!: HTMLInputElement;
  return (
    <openclaw-modal-dialog
      label={title()}
      description={t("sessionsView.personalGroupHint")}
      prop:initialFocus={() => nameInput}
      onModal-cancel={() => props.finish()}
    >
      <form
        class="exec-approval-card exec-approval-modal-stack personal-session-group-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (!label().trim()) {
            return;
          }
          const result = props.options.submit({
            label: label().trim(),
            sessionKeys: [...selected()],
          });
          if (result) {
            setError(result);
          } else {
            props.finish();
          }
        }}
      >
        <div class="exec-approval-header">
          <div class="exec-approval-title">{title()}</div>
        </div>
        <p class="muted">{t("sessionsView.personalGroupHint")}</p>
        <label class="field">
          <span>{t("sessionsView.personalGroupName")}</span>
          <input
            ref={(element) => (nameInput = element)}
            type="text"
            maxlength={80}
            value={label()}
            onInput={(event) => setLabel(event.currentTarget.value)}
            required
          />
        </label>
        <label class="field">
          <span>{t("sessionsView.personalGroupSearch")}</span>
          <input
            type="search"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <div
          role="group"
          aria-label={t("sessionsView.personalGroupSessions")}
          class="stack personal-session-group-dialog__sessions"
        >
          <span class="muted">{t("sessionsView.personalGroupSessions")}</span>
          <For each={rows()} keyed={(row) => row.key}>
            {(row) => (
              <label class="field checkbox personal-session-group-dialog__session">
                <input
                  type="checkbox"
                  checked={selected().has(row().key)}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (checked) {
                        next.add(row().key);
                      } else {
                        next.delete(row().key);
                      }
                      return next;
                    });
                  }}
                />
                <span>{row().label}</span>
              </label>
            )}
          </For>
          <Show when={rows().length === 0}>
            <p class="muted">{t("sessionsView.personalGroupNoMatches")}</p>
          </Show>
        </div>
        <Show when={error()}>
          <div role="alert" class="exec-approval-error">
            {error()}
          </div>
        </Show>
        <openclaw-modal-actions class="exec-approval-actions">
          <button type="button" class="btn" onClick={() => props.finish()}>
            {t("common.cancel")}
          </button>
          <button type="submit" class="btn primary" disabled={!label().trim()}>
            {t("common.save")}
          </button>
        </openclaw-modal-actions>
      </form>
    </openclaw-modal-dialog>
  );
}
