import "./personal-session-group-dialog.css";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { registerSessionOrganizationSharedEnglish } from "../i18n/locales/en-session-organization-shared.ts";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import type {
  PersonalSessionGroup,
  PersonalSessionGroupCandidate,
  PersonalSessionGroupPage,
  PersonalSessionGroupScope,
  PersonalSessionGroupScopeChoices,
} from "../lib/sessions/personal-groups.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import { Icon } from "./solid/icon.tsx";
import { Picker } from "./solid/select-picker.tsx";
import { renderSessionOwnerAvatar } from "./solid/session-presentation.tsx";

registerEnglishCatalog(registerSessionOrganizationSharedEnglish);
registerEnglishCatalog(registerSessionOrganizationEnglish);

export type PersonalSessionGroupDialogOptions = {
  group?: PersonalSessionGroup;
  /** Already-resolved rows, used to show members outside the chosen scope. */
  known: readonly PersonalSessionGroupCandidate[];
  selectedKey?: string;
  scopes: PersonalSessionGroupScopeChoices;
  load: (
    scope: PersonalSessionGroupScope,
    search: string,
  ) => Promise<PersonalSessionGroupPage | null>;
  signal: AbortSignal;
  submit: (value: Pick<PersonalSessionGroup, "label" | "sessionKeys">) => string | null;
};

type ScopeKind = PersonalSessionGroupScope["kind"];
type LoadState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; page: PersonalSessionGroupPage };

const SEARCH_DELAY_MS = 200;

function scopeOptions(choices: PersonalSessionGroupScopeChoices) {
  return [
    ...(choices.personal
      ? ([
          [
            "mine",
            "sessionsView.personalGroupScopeMine",
            "sessionsView.personalGroupScopeMineHint",
          ],
          [
            "involving",
            "sessionsView.personalGroupScopeInvolving",
            "sessionsView.personalGroupScopeInvolvingHint",
          ],
        ] as const)
      : []),
    [
      "all",
      "sessionsView.personalGroupScopeAll",
      "sessionsView.personalGroupScopeAllHint",
    ] as const,
    ...(choices.projects.length
      ? ([
          [
            "project",
            "sessionsView.personalGroupScopeProject",
            "sessionsView.personalGroupScopeProjectHint",
          ],
        ] as const)
      : []),
  ];
}

function SessionChoice(props: {
  row: PersonalSessionGroupCandidate;
  checked: boolean;
  onToggle(checked: boolean): void;
}) {
  return (
    <label class="personal-section-dialog__option">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onToggle(event.currentTarget.checked)}
      />
      <span class="personal-section-dialog__label">{props.row.label}</span>
      <Show when={props.row.ownedBy}>
        {(owner) => (
          <span class="muted personal-section-dialog__aside" title={owner().label}>
            {renderSessionOwnerAvatar(owner())}
            <span>{owner().label?.split(" ")[0] ?? owner().id}</span>
          </span>
        )}
      </Show>
    </label>
  );
}

export function PersonalSessionGroupDialogView(props: {
  options: PersonalSessionGroupDialogOptions;
  finish(): void;
}) {
  const editing = () => Boolean(props.options.group);
  const [step, setStep] = createSignal(() => (props.options.group ? 2 : 1));
  const [label, setLabel] = createSignal(() => props.options.group?.label ?? "");
  const [kind, setKind] = createSignal<ScopeKind>(() =>
    props.options.scopes.personal ? "mine" : "all",
  );
  const [projectId, setProjectId] = createSignal(() => props.options.scopes.projects[0]?.id ?? "");
  const [query, setQuery] = createSignal("");
  const [searching, setSearching] = createSignal(false);
  const [state, setState] = createSignal<LoadState>({ status: "loading" });
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(
    () =>
      new Set(
        props.options.group?.sessionKeys ??
          (props.options.selectedKey ? [props.options.selectedKey] : []),
      ),
  );
  const [error, setError] = createSignal<string | null>(null);
  // Every row seen so far, so selected sessions keep their labels across scopes and searches.
  const seen = createMemo(() => new Map(props.options.known.map((row) => [row.key, row])));
  const scope = (): PersonalSessionGroupScope => {
    const current = kind();
    return current === "project" ? { kind: current, projectId: projectId() } : { kind: current };
  };
  const scopeLabel = () => {
    if (kind() === "project") {
      const project = props.options.scopes.projects.find((entry) => entry.id === projectId());
      return t("sessionsView.personalGroupScopeProjectNamed", { project: project?.label ?? "" });
    }
    return t(
      kind() === "mine"
        ? "sessionsView.personalGroupScopeMine"
        : kind() === "involving"
          ? "sessionsView.personalGroupScopeInvolving"
          : "sessionsView.personalGroupScopeAll",
    );
  };
  // The scope is chosen once, on step 1; step 2 queries it and links back to change it.
  let request = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (delay: number) => {
    clearTimeout(timer);
    const id = ++request;
    setState({ status: "loading" });
    timer = setTimeout(() => {
      // A closed or disconnected editor drops its pending query.
      if (props.options.signal.aborted) {
        return;
      }
      props.options.load(scope(), query().trim()).then(
        (page) => {
          if (id !== request || props.options.signal.aborted) {
            return;
          }
          if (!page) {
            setState({ status: "failed" });
            return;
          }
          for (const row of page.sessions) {
            seen().set(row.key, row);
          }
          setState({ status: "ready", page });
        },
        () => {
          if (id === request) {
            setState({ status: "failed" });
          }
        },
      );
    }, delay);
  };
  // Edits open on the session list, so their first query starts once mounted.
  onSettled(() => {
    if (step() === 2) {
      run(0);
    }
  });
  const page = () => {
    const current = state();
    return current.status === "ready" ? current.page : undefined;
  };
  const results = () => page()?.sessions ?? [];
  // Selected sessions outside this scope stay listed first so they can be unselected.
  const pinned = createMemo(() => {
    const listed = new Set(results().map((row) => row.key));
    const needle = query().trim().toLocaleLowerCase();
    return [...selected()].flatMap((key) => {
      const row = seen().get(key);
      return row && !listed.has(key) && (!needle || row.label.toLocaleLowerCase().includes(needle))
        ? [row]
        : [];
    });
  });
  const selectedCount = createMemo(() => [...selected()].filter((key) => seen().has(key)).length);
  const title = () =>
    t(editing() ? "sessionsView.personalGroupEdit" : "sessionsView.personalGroupNew");
  let nameInput: HTMLInputElement | undefined;
  let searchToggle: HTMLButtonElement | undefined;
  const closeSearch = () => {
    setQuery("");
    setSearching(false);
    run(0);
    queueMicrotask(() => searchToggle?.focus());
  };
  const next = () => {
    if (label().trim()) {
      setStep(2);
      run(0);
    }
  };
  const toggle = (key: string, checked: boolean) =>
    setSelected((previous) => {
      const updated = new Set(previous);
      if (checked) {
        updated.add(key);
      } else {
        updated.delete(key);
      }
      return updated;
    });
  return (
    <openclaw-modal-dialog
      style={{ "--openclaw-modal-width": "480px" }}
      label={title()}
      description={t("sessionsView.personalGroupHint")}
      prop:initialFocus={() => nameInput ?? null}
      onModal-cancel={() => props.finish()}
    >
      <form
        class="exec-approval-card exec-approval-modal-stack personal-session-group-dialog personal-section-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (step() === 1) {
            next();
            return;
          }
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
        <header>
          <div class="personal-section-dialog__row">
            <div class="exec-approval-title">{title()}</div>
            <span class="chip personal-section-dialog__chip">
              <Icon name="eye" />
              {t("sessionsView.personalGroupChip")}
            </span>
          </div>
          <p class="exec-approval-sub">{t("sessionsView.personalGroupHint")}</p>
        </header>
        <Show
          when={step() === 2}
          fallback={
            <>
              <label class="field">
                <span>{t("sessionsView.personalGroupName")}</span>
                <input
                  ref={(element) => (nameInput = element)}
                  type="text"
                  maxlength={80}
                  placeholder={t("sessionsView.personalGroupNamePlaceholder")}
                  value={label()}
                  onInput={(event) => setLabel(event.currentTarget.value)}
                  required
                />
              </label>
              <div
                class="field"
                role="radiogroup"
                aria-label={t("sessionsView.personalGroupScopeLabel")}
              >
                <span>{t("sessionsView.personalGroupScopeLabel")}</span>
                <div class="personal-section-dialog__list personal-section-dialog__scopes">
                  <For each={scopeOptions(props.options.scopes)}>
                    {(option) => (
                      <label class="personal-section-dialog__option">
                        <input
                          type="radio"
                          name="personal-section-scope"
                          value={option[0]}
                          checked={kind() === option[0]}
                          onChange={() => setKind(option[0])}
                        />
                        <span class="personal-section-dialog__label">{t(option[1])}</span>
                        <Show
                          when={option[0] === "project" && kind() === "project"}
                          fallback={
                            <span class="muted personal-section-dialog__aside">{t(option[2])}</span>
                          }
                        >
                          <span class="personal-section-dialog__aside">
                            <Picker
                              id="personal-section-project"
                              label={t("sessionsView.personalGroupProject")}
                              value={projectId()}
                              options={props.options.scopes.projects.map((project) => ({
                                value: project.id,
                                label: project.label,
                              }))}
                              searchable
                              onChange={setProjectId}
                            />
                          </span>
                        </Show>
                      </label>
                    )}
                  </For>
                </div>
              </div>
            </>
          }
        >
          <div class="personal-section-dialog__row personal-section-dialog__head">
            <Show
              when={searching()}
              fallback={
                <>
                  <span class="exec-approval-title personal-section-dialog__label">
                    {scopeLabel()}
                  </span>
                  <span class="muted">
                    {t("sessionsView.personalGroupSelected", { count: String(selectedCount()) })}
                  </span>
                  <button
                    ref={(element) => (searchToggle = element)}
                    type="button"
                    class="btn btn--sm btn--icon btn--ghost"
                    aria-label={t("sessionsView.personalGroupSearch")}
                    title={t("sessionsView.personalGroupSearch")}
                    onClick={() => setSearching(true)}
                  >
                    <Icon name="search" />
                  </button>
                </>
              }
            >
              <input
                ref={[
                  // Escape clears, then closes, search before the dialog treats it as cancel.
                  nativeListener("keydown", (event) => {
                    if (event.isComposing) {
                      return;
                    }
                    if (event.key === "Enter") {
                      // Enter filters; it must not submit (save) the section.
                      event.preventDefault();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      if (query()) {
                        setQuery("");
                        run(0);
                      } else {
                        closeSearch();
                      }
                    }
                  }),
                  (element: HTMLInputElement) => queueMicrotask(() => element.focus()),
                ]}
                type="search"
                class="input personal-section-dialog__label"
                aria-label={t("sessionsView.personalGroupSearch")}
                placeholder={t("sessionsView.personalGroupSearch")}
                value={query()}
                onInput={(event) => {
                  setQuery(event.currentTarget.value);
                  run(SEARCH_DELAY_MS);
                }}
              />
              <button
                type="button"
                class="btn btn--sm btn--icon btn--ghost"
                aria-label={t("sessionsView.personalGroupSearchClose")}
                title={t("sessionsView.personalGroupSearchClose")}
                onClick={closeSearch}
              >
                <Icon name="x" />
              </button>
            </Show>
          </div>
          <div
            role="group"
            aria-label={t("sessionsView.personalGroupSessions")}
            aria-busy={state().status === "loading" ? "true" : "false"}
            class="personal-section-dialog__list personal-session-group-dialog__sessions"
          >
            <Show when={pinned().length > 0}>
              <p class="muted personal-section-dialog__note">
                {t(
                  editing()
                    ? "sessionsView.personalGroupInSection"
                    : "sessionsView.personalGroupAdded",
                )}
              </p>
              <For each={pinned()} keyed={(row) => row.key}>
                {(row) => (
                  <SessionChoice
                    row={row()}
                    checked={selected().has(row().key)}
                    onToggle={(checked) => toggle(row().key, checked)}
                  />
                )}
              </For>
              <Show when={results().length > 0}>
                <p class="muted personal-section-dialog__note">{scopeLabel()}</p>
              </Show>
            </Show>
            <For each={results()} keyed={(row) => row.key}>
              {(row) => (
                <SessionChoice
                  row={row()}
                  checked={selected().has(row().key)}
                  onToggle={(checked) => toggle(row().key, checked)}
                />
              )}
            </For>
            <Show when={state().status === "loading" && results().length === 0}>
              <p class="muted personal-section-dialog__note">
                {t("sessionsView.personalGroupLoading")}
              </p>
            </Show>
            <Show when={state().status === "failed"}>
              <p class="muted personal-section-dialog__note">
                {t("sessionsView.personalGroupLoadFailed")}{" "}
                <button type="button" class="btn btn--sm btn--ghost" onClick={() => run(0)}>
                  {t("sessionsView.personalGroupRetry")}
                </button>
              </p>
            </Show>
            <Show
              when={state().status === "ready" && results().length === 0 && pinned().length === 0}
            >
              <p class="muted personal-section-dialog__note">
                {t("sessionsView.personalGroupNoMatches")}
              </p>
            </Show>
            <Show when={page()?.hasMore}>
              <p class="muted personal-section-dialog__note">
                {t("sessionsView.personalGroupMore")}
              </p>
            </Show>
          </div>
        </Show>
        <Show when={error()}>
          <div role="alert" class="exec-approval-error">
            {error()}
          </div>
        </Show>
        <openclaw-modal-actions>
          <Show
            when={step() === 2}
            fallback={
              <span class="muted personal-section-dialog__lead">
                {t("sessionsView.personalGroupStep")}
              </span>
            }
          >
            <button
              type="button"
              class="btn btn--ghost personal-section-dialog__lead"
              onClick={() => setStep(1)}
            >
              <Icon name="chevronLeft" />
              {t("common.back")}
            </button>
          </Show>
          <button type="button" class="btn" onClick={() => props.finish()}>
            {t("common.cancel")}
          </button>
          <button type="submit" class="btn primary" disabled={!label().trim()}>
            {step() === 1 ? t("sessionsView.personalGroupNext") : t("common.save")}
          </button>
        </openclaw-modal-actions>
      </form>
    </openclaw-modal-dialog>
  );
}
