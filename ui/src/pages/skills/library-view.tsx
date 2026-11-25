import type { JSX } from "@solidjs/web";
import { createMemo, Errored, For, lazy, Loading, Show } from "solid-js";
import { foldSearchCase } from "../../../../src/shared/search-case.js";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { LibraryDetailOutcome, SkillLibraryModel } from "./library-state.ts";
import { SkillLibraryToolbar } from "./library-toolbar.tsx";
import { SkillDialogBoundary } from "./skill-dialog-boundary.tsx";

const LibraryEditor = lazy(() => import("./library-dialog-content.tsx"), {
  export: "LibraryEditor",
});
const LibraryImport = lazy(() => import("./library-dialog-content.tsx"), {
  export: "LibraryImport",
});

export function SkillLibrary(props: {
  library: SkillLibraryModel;
  navigationActions: JSX.Element;
  pageMenu?: () => JSX.Element;
}) {
  const current = () => props.library.state;
  const busy = () => props.library.saving() || current().busy;
  // List receipts replace the snapshot; mutable editor drafts and feedback do not.
  const acceptedList = createMemo(() => current().list);
  const completion = createMemo(() => current().listRead);
  const read = createMemo(
    () => completion()?.completion ?? Promise.resolve({ list: acceptedList(), error: null }),
  );
  // Accepted rows stay live; the shared feedback also owns refresh errors.
  const readError = () => {
    const error = acceptedList() ? null : read().error;
    if (error) {
      throw new Error(error);
    }
    return null;
  };
  const Entries = () => {
    const list = createMemo(() => acceptedList() ?? read().list);
    // Canonical-form comparison: a composed (NFC) query must match decomposed (NFD) copy.
    const query = createMemo(() =>
      foldSearchCase(props.library.local.query.trim()).normalize("NFC"),
    );
    const scope = createMemo(() => current().view);
    const entries = createMemo(() => {
      const snapshot = list();
      const search = query();
      const view = scope();
      return props.library.entries().filter((entry) => {
        const scopeMatches =
          view === "mine"
            ? entry.ownerProfileId === snapshot?.profileId
            : view !== "team" || entry.shared || entry.ownerProfileId === null;
        return (
          scopeMatches &&
          (!search ||
            foldSearchCase(`${entry.slug} ${entry.name} ${entry.description} ${entry.ownerLabel}`)
              .normalize("NFC")
              .includes(search))
        );
      });
    });
    return (
      <SettingsSection title={t(`skillLibrary.${current().view}`)} count={entries().length}>
        <Show
          when={entries().length > 0}
          fallback={
            <SettingsEmpty message={t(query() ? "skillLibrary.noMatches" : "skillLibrary.empty")} />
          }
        >
          <For each={entries()} keyed={(entry) => entry.skillId}>
            {(entry) => (
              <div class="settings-row">
                <button
                  type="button"
                  class="settings-row__text plugins-item__detail-button"
                  disabled={busy() || current().loading}
                  onClick={() => void props.library.open(entry().skillId)}
                >
                  <span class="settings-row__title">{entry().slug}</span>
                  <span class="settings-row__desc">{entry().description}</span>
                  <span class="settings-row__desc">
                    {entry().ownerLabel} ·{" "}
                    {entry().shared ? t("skillLibrary.shared") : t("skillLibrary.private")} ·{" "}
                    {entry().revision.slice(0, 8)}
                  </span>
                </button>
                <div class="settings-row__control">
                  <SettingsStatus
                    kind={entry().enabled ? "ok" : "muted"}
                    label={t(entry().enabled ? "skillsPage.enabled" : "skillsPage.disabled")}
                  />
                </div>
              </div>
            )}
          </For>
        </Show>
      </SettingsSection>
    );
  };
  return (
    <>
      <SkillLibraryToolbar library={props.library} navigationActions={props.navigationActions} />
      <Show when={current().list?.defaultTarget === "unavailable"}>
        <p class="muted">{t("skillLibrary.signIn")}</p>
      </Show>
      <SkillLibraryFeedback library={props.library} />
      <Show when={current().list && !props.library.showWorkspace()}>
        <p class="muted">
          {t("skillLibrary.defaultLimit", {
            count: String(current().list!.defaultSelectionLimit),
          })}
        </p>
        <Show when={current().list?.defaultSelectionNotice}>
          <p class="callout" role="status">
            {current().list?.defaultSelectionNotice}
          </p>
        </Show>
      </Show>
      <Show when={!props.library.showWorkspace()}>
        <div class="skill-library-search">
          <label class="field">
            <span>{t("common.search")}</span>
            <input
              class="settings-input"
              name="library-search"
              value={props.library.local.query}
              placeholder={t("skillLibrary.search")}
              onInput={(event) =>
                props.library.setLocal((state) => {
                  state.query = event.currentTarget.value;
                })
              }
            />
          </label>
          <span class="skill-library-search__action">
            <RefreshButton
              label={t("common.refresh")}
              busy={current().loading}
              disabled={props.library.saving() || current().busy}
              onClick={() => void props.library.load()}
            />
          </span>
          {props.pageMenu?.()}
        </div>
        {/* A stable list host keeps async replacement from reparenting the focused search field. */}
        <div>
          <Loading on={acceptedList() ? null : completion()} fallback={<SettingsLoadingSkeleton />}>
            <Errored fallback={() => null}>{readError()}</Errored>
            <Entries />
          </Loading>
        </div>
      </Show>
      <SkillLibraryDialogs library={props.library} />
    </>
  );
}

export function SkillLibraryFeedback(props: {
  library: SkillLibraryModel;
  dialog?: "editor" | "import";
}) {
  const current = () => props.library.state;
  return (
    <>
      <Show
        when={
          current().error && (props.dialog || (!current().draft && !props.library.local.importOpen))
        }
      >
        <InlineAlert tone="danger" role="alert">
          {current().error}
        </InlineAlert>
      </Show>
      <Show
        when={
          current().notice && (props.dialog === "editor" || (!props.dialog && !current().draft))
        }
      >
        <InlineAlert tone="success" role="status">
          {current().notice}
        </InlineAlert>
      </Show>
    </>
  );
}

export function SkillLibraryDialogs(props: { library: SkillLibraryModel }) {
  return (
    <>
      <Show when={props.library.state.detailRead} keyed>
        {(receipt) => <LibraryDetailRead completion={receipt.completion} />}
      </Show>
      <Show when={props.library.state.draft}>
        <SkillDialogBoundary
          onClose={() => void props.library.close()}
          closeDisabled={props.library.saving() || props.library.state.busy}
        >
          <LibraryEditor
            library={props.library}
            feedback={<SkillLibraryFeedback library={props.library} dialog="editor" />}
          />
        </SkillDialogBoundary>
      </Show>
      <Show when={props.library.local.importOpen}>
        <SkillDialogBoundary
          onClose={() => void props.library.close()}
          closeDisabled={props.library.saving() || props.library.state.busy}
        >
          <LibraryImport
            library={props.library}
            feedback={<SkillLibraryFeedback library={props.library} dialog="import" />}
          />
        </SkillDialogBoundary>
      </Show>
    </>
  );
}

function LibraryDetailRead(props: { completion: Promise<LibraryDetailOutcome> }) {
  const outcome = createMemo(() => props.completion);
  const readError = () => {
    const result = outcome();
    if (result) {
      throw result.error;
    }
    return null;
  };
  // The existing owner feedback displays errors without replacing an accepted draft.
  return (
    <Loading>
      <Errored fallback={() => null}>{readError()}</Errored>
    </Loading>
  );
}
