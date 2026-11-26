import { createMemo, createSignal, createStore, For, onSettled, Show } from "solid-js";
import {
  editVoiceSnippetCatalog,
  searchVoiceSnippets,
  VOICE_SNIPPET_CATALOG_BYTES,
  VoiceSnippetValidationError,
  voiceSnippetUtf8Bytes,
  type VoiceSnippet,
  type VoiceSnippetCatalog,
} from "../../../../../src/shared/voice-snippets.ts";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { DialogHeader } from "../../../components/solid/dialog-header.tsx";
import { InlineAlert } from "../../../components/solid/inline-alert.tsx";
import { registerChatDictationEnglish } from "../../../i18n/locales/en-chat-dictation.ts";
import { downloadTextFile } from "../../../lib/download.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { generateUUID } from "../../../lib/uuid.ts";
import {
  VoiceSnippetCatalogView,
  type VoiceSnippetCatalogError,
} from "../voice-snippet-catalog.ts";
import "./voice-snippets.css";

registerEnglishCatalog(registerChatDictationEnglish);

type CatalogDialogContext = {
  client: GatewayBrowserClient;
  signal: AbortSignal;
  returnFocus: HTMLElement | null;
  onClose: () => void;
};

export function VoiceSnippetCatalogDialog(props: { context: CatalogDialogContext }) {
  return (
    <Show when={props.context} keyed>
      {(context) =>
        renderVoiceSnippetCatalogDialog(
          new VoiceSnippetCatalogView(context.client, context.signal),
          context.onClose,
          context.returnFocus,
        )
      }
    </Show>
  );
}

function renderVoiceSnippetCatalogDialog(
  owner: VoiceSnippetCatalogView,
  onClose: () => void,
  returnFocus: HTMLElement | null,
) {
  const state = projectOwner(owner, (owner) => owner);
  const [query, setQuery] = createSignal("");
  const [editing, setEditing] = createSignal<VoiceSnippet>();
  const [deleting, setDeleting] = createSignal<VoiceSnippet>();
  const [pendingImport, setPendingImport] = createSignal<{
    data: string;
    catalog: VoiceSnippetCatalog;
  }>();
  const [importError, setImportError] = createSignal<VoiceSnippetCatalogError>();
  const [status, setStatus] = createSignal("");
  const matches = createMemo(() => {
    const catalog = state.read().catalog;
    return catalog ? searchVoiceSnippets(catalog, query()) : [];
  });
  let searchInput!: HTMLInputElement;
  let importInput!: HTMLInputElement;
  let confirmCancel: HTMLButtonElement | undefined;
  let importRevision = 0;
  const close = () => {
    if (!state.read().busy) {
      onClose();
    }
  };
  const back = () => {
    importRevision += 1;
    setEditing(undefined);
    setDeleting(undefined);
    setPendingImport(undefined);
    setImportError(undefined);
    onSettled(() => searchInput?.focus());
  };
  const editSnippet = (snippet: VoiceSnippet) => {
    importRevision += 1;
    setEditing(snippet);
  };
  const deleteSnippet = (snippet: VoiceSnippet) => {
    importRevision += 1;
    setDeleting(snippet);
    onSettled(() => confirmCancel?.focus());
  };
  onSettled(() => {
    void owner.load().then((loaded) => {
      if (loaded && owner.available) {
        onSettled(() => searchInput?.focus());
      }
    });
  });

  async function importFile(file: File | undefined) {
    if (!file || !owner.catalog) {
      return;
    }
    const revision = ++importRevision;
    setImportError(undefined);
    try {
      if (file.size > VOICE_SNIPPET_CATALOG_BYTES) {
        throw new VoiceSnippetValidationError("catalog-too-large");
      }
      const data = await file.text();
      if (!owner.available || revision !== importRevision) {
        return;
      }
      const catalog = editVoiceSnippetCatalog(owner.catalog, { type: "import", data });
      setPendingImport({ data, catalog });
      onSettled(() => confirmCancel?.focus());
    } catch (error) {
      if (owner.available && revision === importRevision) {
        setImportError(error instanceof VoiceSnippetValidationError ? error.code : "unavailable");
      }
    }
  }

  return (
    <openclaw-modal-dialog
      class="voice-snippets-dialog"
      ref={(modal) => modal.setReturnFocusTarget(returnFocus)}
      label={t("chat.dictation.snippets.title")}
      prop:initialFocus={() => searchInput}
      onModal-cancel={(event: Event) => {
        if (state.read().busy) {
          event.preventDefault();
        } else {
          onClose();
        }
      }}
    >
      <div class="oc-dialog">
        <DialogHeader
          title={t("chat.dictation.snippets.title")}
          description={<p>{t("chat.dictation.snippets.description")}</p>}
          closeDisabled={state.read().busy}
          onClose={close}
        />
        <div class="oc-dialog__body">
          <Show when={!state.read().catalog && state.read().busy}>
            <p role="status">{t("chat.dictation.snippets.refreshing")}</p>
          </Show>
          <Show when={state.read().error || importError()}>
            {(error) => (
              <InlineAlert tone="danger" role="alert">
                {t(`chat.dictation.snippets.error.${error()}`)}
                <Show when={error() === "conflict"}>
                  <p>{t("chat.dictation.snippets.conflictHint")}</p>
                </Show>
              </InlineAlert>
            )}
          </Show>
          <Show when={state.read().collisionIds.length > 0}>
            <div role="group" aria-label={t("chat.dictation.snippets.collisions")}>
              <For each={state.read().collisionIds.slice(0, 10)}>
                {(id) => (
                  <p>
                    {state.read().catalog?.snippets.find((snippet) => snippet.id === id)?.name ??
                      id}
                  </p>
                )}
              </For>
            </div>
          </Show>
          <Show when={state.read().available && (state.read().error || !state.read().catalog)}>
            <button
              type="button"
              class="btn"
              disabled={state.read().busy}
              onClick={() => void owner.load()}
            >
              {t("chat.dictation.snippets.refresh")}
            </button>
          </Show>
          <Show when={state.read().catalog && editing()} keyed>
            {(snippet) => (
              <SnippetEditor
                initial={snippet}
                busy={state.read().busy}
                onCancel={back}
                onSave={async (definition) => {
                  if (
                    await owner.edit({
                      type: "save",
                      snippet: definition,
                      expectedRevision: snippet.revision || null,
                    })
                  ) {
                    setStatus(t("chat.dictation.snippets.saved"));
                    back();
                  }
                }}
              />
            )}
          </Show>
          <Show when={state.read().catalog && deleting()} keyed>
            {(snippet) => (
              <section>
                <h3>{snippet.name}</h3>
                <p>{t("chat.dictation.snippets.deleteConfirm")}</p>
                <openclaw-modal-actions>
                  <button
                    type="button"
                    class="btn"
                    disabled={state.read().busy}
                    onClick={back}
                    ref={(element) => (confirmCancel = element)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    class="btn danger"
                    disabled={state.read().busy}
                    onClick={() => {
                      void owner
                        .edit({
                          type: "delete",
                          id: snippet.id,
                          expectedRevision: snippet.revision,
                        })
                        .then((saved) => {
                          if (saved) {
                            setStatus(t("chat.dictation.snippets.deleted"));
                            back();
                          }
                        });
                    }}
                  >
                    {t("chat.dictation.snippets.delete")}
                  </button>
                </openclaw-modal-actions>
              </section>
            )}
          </Show>
          <Show when={state.read().catalog && pendingImport()} keyed>
            {(pending) => (
              <section class="voice-snippets-form">
                <h3>{t("chat.dictation.snippets.importReview")}</h3>
                <p>{t("chat.dictation.snippets.importWarning")}</p>
                <p>
                  {t("chat.dictation.snippets.importCount", {
                    count: String(pending.catalog.snippets.length),
                  })}
                </p>
                <div class="voice-snippets-import-preview">
                  <For each={pending.catalog.snippets} keyed={(snippet) => snippet.id}>
                    {(snippet) => (
                      <details>
                        <summary>{snippet().name}</summary>
                        <textarea
                          class="settings-input voice-snippets-preview"
                          aria-label={`${snippet().name}: ${t("chat.dictation.snippets.preview")}`}
                          readonly
                          value={snippet().body}
                        />
                      </details>
                    )}
                  </For>
                </div>
                <openclaw-modal-actions>
                  <button
                    type="button"
                    class="btn"
                    disabled={state.read().busy}
                    onClick={back}
                    ref={(element) => (confirmCancel = element)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    class="btn primary"
                    disabled={state.read().busy}
                    onClick={() => {
                      void owner.edit({ type: "import", data: pending.data }).then((saved) => {
                        if (saved) {
                          setStatus(t("chat.dictation.snippets.imported"));
                          back();
                        }
                      });
                    }}
                  >
                    {t("chat.dictation.snippets.importReplace")}
                  </button>
                </openclaw-modal-actions>
              </section>
            )}
          </Show>
          <Show when={state.read().catalog && !editing() && !deleting() && !pendingImport()}>
            <label class="voice-snippets-check">
              <input
                type="checkbox"
                checked={state.read().catalog?.enabled ?? false}
                disabled={state.read().busy}
                onChange={(event) => {
                  void owner
                    .edit({ type: "enabled", enabled: event.currentTarget.checked })
                    .then((saved) => {
                      if (saved) {
                        setStatus(t("chat.dictation.snippets.updated"));
                      }
                    });
                }}
              />
              {t("chat.dictation.snippets.enabled")}
            </label>
            <p class="muted">{t("chat.dictation.snippets.disabledHint")}</p>
            <div class="voice-snippets-toolbar">
              <input
                class="settings-input"
                type="search"
                aria-label={t("chat.dictation.snippets.search")}
                placeholder={t("chat.dictation.snippets.search")}
                value={query()}
                ref={(element) => (searchInput = element)}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
              <button
                type="button"
                class="btn primary"
                disabled={state.read().busy}
                onClick={() =>
                  editSnippet({
                    schemaVersion: 1,
                    id: generateUUID(),
                    revision: 0,
                    name: "",
                    locale: "en-US",
                    triggers: [],
                    body: "",
                    enabled: true,
                    sensitivity: "normal",
                  })
                }
              >
                {t("chat.dictation.snippets.add")}
              </button>
            </div>
            <ul class="voice-snippets-list">
              <For
                each={matches()}
                keyed={(snippet) => snippet.id}
                fallback={
                  <li class="muted">
                    {t(
                      query()
                        ? "chat.dictation.snippets.noMatches"
                        : "chat.dictation.snippets.empty",
                    )}
                  </li>
                }
              >
                {(snippet) => (
                  <li class="voice-snippets-row">
                    <div class="voice-snippets-row__copy">
                      <strong>{snippet().name}</strong>
                      <p class="muted">
                        {snippet().triggers.join(" · ")} · {snippet().locale}
                      </p>
                      <p>
                        {t(
                          snippet().enabled
                            ? "chat.dictation.snippets.on"
                            : "chat.dictation.snippets.off",
                        )}
                        {snippet().sensitivity === "sensitive"
                          ? ` · ${t("chat.dictation.snippets.sensitive")}`
                          : ""}
                      </p>
                    </div>
                    <div class="voice-snippets-row__actions">
                      <button
                        type="button"
                        class="btn btn--sm"
                        disabled={state.read().busy}
                        onClick={() => editSnippet(snippet())}
                      >
                        {t("chat.dictation.snippets.edit")}
                      </button>
                      <button
                        type="button"
                        class="btn btn--sm"
                        disabled={state.read().busy}
                        onClick={() => {
                          const current = snippet();
                          void owner
                            .edit({
                              type: "save",
                              snippet: { ...current, enabled: !current.enabled },
                              expectedRevision: current.revision,
                            })
                            .then((saved) => {
                              if (saved) {
                                setStatus(t("chat.dictation.snippets.updated"));
                              }
                            });
                        }}
                      >
                        {t(
                          snippet().enabled
                            ? "chat.dictation.snippets.disable"
                            : "chat.dictation.snippets.enable",
                        )}
                      </button>
                      <button
                        type="button"
                        class="btn btn--sm"
                        disabled={state.read().busy}
                        onClick={() => deleteSnippet(snippet())}
                      >
                        {t("chat.dictation.snippets.delete")}
                      </button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
            <p class="muted">{t("chat.dictation.snippets.limits")}</p>
            <p class="muted">{t("chat.dictation.snippets.exportWarning")}</p>
            <div class="voice-snippets-toolbar">
              <input
                type="file"
                accept="application/json,.json"
                aria-label={t("chat.dictation.snippets.importData")}
                hidden
                ref={(element) => (importInput = element)}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  void importFile(file);
                }}
              />
              <button
                type="button"
                class="btn"
                disabled={state.read().busy}
                onClick={() => importInput.click()}
              >
                {t("chat.dictation.snippets.import")}
              </button>
              <button
                type="button"
                class="btn"
                disabled={state.read().busy}
                onClick={() => {
                  void owner.export().then((data) => {
                    if (data !== null && owner.available) {
                      downloadTextFile("openclaw-voice-snippets.json", data, "application/json");
                      setStatus(t("chat.dictation.snippets.exported"));
                    }
                  });
                }}
              >
                {t("chat.dictation.snippets.export")}
              </button>
            </div>
          </Show>
          <p role="status" aria-live="polite" aria-atomic="true">
            {status()}
          </p>
        </div>
        <openclaw-modal-actions class="oc-dialog__footer">
          <button type="button" class="btn" disabled={state.read().busy} onClick={close}>
            {t("common.close")}
          </button>
        </openclaw-modal-actions>
      </div>
    </openclaw-modal-dialog>
  );
}

function SnippetEditor(props: {
  initial: VoiceSnippet;
  busy: boolean;
  onCancel: () => void;
  onSave: (snippet: Omit<VoiceSnippet, "schemaVersion" | "revision">) => Promise<void>;
}) {
  // Keyed to one immutable edit revision; unrelated catalog refreshes retain typed text.
  const [draft, setDraft] = createStore(() => ({
    ...props.initial,
    triggerLines: props.initial.triggers.join("\n"),
  }));
  let nameInput!: HTMLInputElement;
  onSettled(() => nameInput.focus());
  return (
    <form
      class="voice-snippets-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (props.busy) {
          return;
        }
        void props.onSave({
          id: props.initial.id,
          name: draft.name,
          locale: draft.locale,
          triggers:
            draft.triggerLines === props.initial.triggers.join("\n")
              ? props.initial.triggers
              : draft.triggerLines
                  .split("\n")
                  .map((trigger) => trigger.trim())
                  .filter(Boolean),
          body: draft.body,
          enabled: draft.enabled,
          sensitivity: draft.sensitivity,
        });
      }}
    >
      <label class="voice-snippets-field">
        {t("chat.dictation.snippets.name")}
        <input
          class="settings-input"
          name="snippetName"
          maxlength={256}
          required
          value={draft.name}
          disabled={props.busy}
          ref={(element) => (nameInput = element)}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setDraft((next) => {
              next.name = value;
            });
          }}
        />
      </label>
      <label class="voice-snippets-field">
        {t("chat.dictation.snippets.locale")}
        <input
          class="settings-input"
          name="snippetLocale"
          maxlength={64}
          required
          value={draft.locale}
          disabled={props.busy}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setDraft((next) => {
              next.locale = value;
            });
          }}
        />
      </label>
      <label class="voice-snippets-field">
        {t("chat.dictation.snippets.triggers")}
        <textarea
          class="settings-input"
          name="snippetTriggers"
          required
          rows={3}
          value={draft.triggerLines}
          disabled={props.busy}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setDraft((next) => {
              next.triggerLines = value;
            });
          }}
        />
      </label>
      <label class="voice-snippets-field">
        {t("chat.dictation.snippets.body")}
        <textarea
          class="settings-input voice-snippets-preview"
          name="snippetBody"
          required
          spellcheck={false}
          value={draft.body}
          disabled={props.busy}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setDraft((next) => {
              next.body = value;
            });
          }}
        />
      </label>
      <p class="muted">
        {t("chat.dictation.snippets.bytes", { bytes: String(voiceSnippetUtf8Bytes(draft.body)) })}
      </p>
      <p class="muted">{t("chat.dictation.snippets.staticHint")}</p>
      <label class="voice-snippets-check">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={props.busy}
          onChange={(event) => {
            const value = event.currentTarget.checked;
            setDraft((next) => {
              next.enabled = value;
            });
          }}
        />
        {t("chat.dictation.snippets.on")}
      </label>
      <label class="voice-snippets-check">
        <input
          type="checkbox"
          checked={draft.sensitivity === "sensitive"}
          disabled={props.busy}
          onChange={(event) => {
            const value = event.currentTarget.checked;
            setDraft((next) => {
              next.sensitivity = value ? "sensitive" : "normal";
            });
          }}
        />
        {t("chat.dictation.snippets.sensitive")}
      </label>
      <details>
        <summary>{t("chat.dictation.snippets.preview")}</summary>
        <textarea
          class="settings-input voice-snippets-preview"
          aria-label={t("chat.dictation.snippets.preview")}
          readonly
          value={draft.body}
        />
      </details>
      <openclaw-modal-actions>
        <button type="button" class="btn" disabled={props.busy} onClick={() => props.onCancel()}>
          {t("common.cancel")}
        </button>
        <button type="submit" class="btn primary" disabled={props.busy}>
          {t("chat.dictation.snippets.save")}
        </button>
      </openclaw-modal-actions>
    </form>
  );
}
