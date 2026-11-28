import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { WRITING_PROFILE_LIMITS } from "../../../../src/shared/dictation-writing-profiles.js";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { registerDictationWritingProfilesEnglish } from "../../i18n/locales/en-dictation-writing-profiles.ts";
import { downloadTextFile } from "../../lib/download.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { createWritingProfileEditor } from "./dictation-writing-profile-editor.ts";
import { WritingProfileFields } from "./dictation-writing-profile-fields.tsx";
import "./dictation-writing-profiles.css";

registerDictationWritingProfilesEnglish();
const copy = "talkPage.writingProfiles.";

export function DictationWritingProfilesSection() {
  const context = useApplication();
  const editor = createWritingProfileEditor(context.gateway);
  const state = projectOwner(editor, (owner) => owner.snapshot);
  const [importText, setImportText] = createSignal("");
  const blocked = createMemo(
    () =>
      state.read().busy || !state.read().connected || Boolean(state.read().current?.readOnlyReason),
  );
  let profilePicker: HTMLSelectElement | undefined;
  let createButton: HTMLButtonElement | undefined;
  onSettled(() => editor.start());

  const download = (content: string | null, filename: string) => {
    if (content !== null) {
      downloadTextFile(filename, content, "application/json");
    }
  };
  return (
    <div class="writing-profiles" id="dictation-writing-profiles">
      <SettingsSection title={t(copy + "title")} description={t(copy + "description")}>
        <div class="writing-profiles__body stack" aria-busy={state.read().busy ? "true" : "false"}>
          <p>{t(copy + "capabilities")}</p>
          <p>{t(copy + "processing")}</p>
          <p class="callout info" role="status" aria-live="polite" aria-atomic="true">
            {t(copy + "statuses." + state.read().status)}
          </p>
          <Show when={state.read().issues.length > 0}>
            <ul class="muted">
              <For each={state.read().issues}>
                {(issue) => <li>{t(copy + "issue", { path: issue.path, code: issue.code })}</li>}
              </For>
            </ul>
          </Show>
          <Show when={state.read().draft}>
            {(draft) => (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void editor.save();
                }}
              >
                <fieldset class="writing-profiles__controls stack" disabled={blocked()}>
                  <legend class="sr-only">{t(copy + "title")}</legend>
                  <label class="field checkbox">
                    <input
                      type="checkbox"
                      checked={draft().enabled}
                      onChange={(event) =>
                        editor.updateCatalog({ enabled: event.currentTarget.checked })
                      }
                    />
                    <span>{t(copy + "enabled")}</span>
                  </label>
                  <label class="field">
                    <span>{t(copy + "default")}</span>
                    <select
                      class="settings-select"
                      value={draft().defaultProfileId ?? ""}
                      onChange={(event) =>
                        editor.updateCatalog({
                          defaultProfileId: event.currentTarget.value || null,
                        })
                      }
                    >
                      <option value="">{t(copy + "noDefault")}</option>
                      <For each={draft().profiles} keyed={(profile) => profile.id}>
                        {(profile) => (
                          <option value={profile().id} disabled={!profile().enabled}>
                            {profile().label}
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                  <div class="filters">
                    <Show when={draft().profiles.length > 0}>
                      <label class="field writing-profiles__picker">
                        <span>{t(copy + "choose")}</span>
                        <select
                          ref={(element) => (profilePicker = element)}
                          class="settings-select"
                          value={state.read().selectedId ?? ""}
                          onChange={(event) => editor.select(event.currentTarget.value)}
                        >
                          <For each={draft().profiles} keyed={(profile) => profile.id}>
                            {(profile) => <option value={profile().id}>{profile().label}</option>}
                          </For>
                        </select>
                      </label>
                    </Show>
                    <button
                      ref={(element) => (createButton = element)}
                      class="btn btn--sm"
                      type="button"
                      disabled={draft().profiles.length >= WRITING_PROFILE_LIMITS.profiles}
                      onClick={() => editor.add(t(copy + "newLabel"))}
                    >
                      {t(copy + "add")}
                    </button>
                  </div>
                  <Show when={state.read().selectedId} keyed fallback={<p>{t(copy + "empty")}</p>}>
                    {(profileId) => (
                      <Show
                        when={state
                          .read()
                          .draft?.profiles.find((profile) => profile.id === profileId)}
                      >
                        {(profile) => (
                          <>
                            <WritingProfileFields
                              profile={profile()}
                              onChange={(patch) => editor.updateProfile(patch)}
                            />
                            <button
                              class="btn btn--sm"
                              type="button"
                              onClick={() => {
                                editor.remove();
                                onSettled(() =>
                                  (editor.snapshot.selectedId
                                    ? profilePicker
                                    : createButton
                                  )?.focus(),
                                );
                              }}
                            >
                              {t(copy + "remove")}
                            </button>
                          </>
                        )}
                      </Show>
                    )}
                  </Show>
                  <div class="filters writing-profiles__save">
                    <button
                      class="btn primary"
                      type="submit"
                      disabled={!state.read().dirty || state.read().requiresReload}
                    >
                      {t(copy + "save")}
                    </button>
                  </div>
                </fieldset>
              </form>
            )}
          </Show>
          <div class="filters">
            <button
              class="btn btn--sm"
              type="button"
              disabled={state.read().busy || !state.read().connected}
              onClick={() => {
                void editor.reload();
              }}
            >
              {t(copy + "refresh")}
            </button>
            <Show when={state.read().dirty}>
              <button
                class="btn btn--sm"
                type="button"
                onClick={() =>
                  download(editor.exportDraft(), "dictation-writing-profiles-draft.json")
                }
              >
                {t(copy + "exportDraft")}
              </button>
            </Show>
          </div>
          <Show when={state.read().dirty}>
            <p>{t(copy + "refreshHelp")}</p>
          </Show>
          <details class="writing-profiles__disclosure">
            <summary>{t(copy + "transfer")}</summary>
            <p>{t(copy + "transferHelp")}</p>
            <button
              class="btn btn--sm"
              type="button"
              disabled={!state.read().current}
              onClick={() => download(editor.exportSaved(), "dictation-writing-profiles.json")}
            >
              {t(copy + "export")}
            </button>
            <label class="field">
              <span>{t(copy + "importLabel")}</span>
              <textarea
                class="settings-input"
                rows={6}
                spellcheck="false"
                value={importText()}
                maxlength={WRITING_PROFILE_LIMITS.catalogBytes}
                disabled={blocked()}
                onInput={(event) => setImportText(event.currentTarget.value)}
              />
            </label>
            <Show when={state.read().dirty}>
              <p>{t(copy + "importBlocked")}</p>
            </Show>
            <button
              class="btn btn--sm"
              type="button"
              disabled={
                blocked() ||
                state.read().requiresReload ||
                state.read().dirty ||
                !state.read().current ||
                !importText().trim()
              }
              onClick={() => {
                void editor.import(importText());
              }}
            >
              {t(copy + "import")}
            </button>
            <Show when={state.read().quarantinedImport}>
              <p role="status">{t(copy + "quarantine")}</p>
              <button
                class="btn btn--sm"
                type="button"
                onClick={() =>
                  download(
                    state.read().quarantinedImport,
                    "dictation-writing-profiles-quarantined.json",
                  )
                }
              >
                {t(copy + "exportQuarantined")}
              </button>
            </Show>
          </details>
        </div>
      </SettingsSection>
    </div>
  );
}
