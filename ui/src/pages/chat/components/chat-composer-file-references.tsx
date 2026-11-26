import { createMemo, For, Show } from "solid-js";
import { registerChatFileReferencesEnglish } from "../../../i18n/locales/en-chat-file-references.ts";
import { prepareFileReferenceDestination } from "../../../lib/chat/file-reference-destination.ts";
import { fileReferenceText } from "../../../lib/chat/file-references.ts";
import { focusComposerInput } from "../../../lib/composer-input.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import type { ComposerFileReferenceOwner } from "../composer-file-references.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

registerEnglishCatalog(registerChatFileReferencesEnglish);

const phaseCopy = {
  idle: "idle",
  preparing: "preparing",
  searching: "searching",
  choosing: "choosing",
  confirming: "confirming",
  committed: "committed",
  copied: "copied",
  denied: "denied",
  unsupported: "unsupported",
  stale: "stale",
  expired: "expired",
  offline: "offline",
  "no-matches": "noMatches",
  "copy-failed": "copyFailed",
  "conversion-failed": "conversionFailed",
  "outcome-unknown": "unknown",
} as const;

export function ComposerFileReferences(props: {
  owner: ComposerFileReferenceOwner;
  composer: ChatComposerProps;
  state: ChatComposerState;
}) {
  const projection = createMemo(() => projectOwner(props.owner, (owner) => owner));
  const read = () => projection().read();
  const focus = (target: HTMLTextAreaElement | null) => {
    const state = props.state;
    queueMicrotask(() => {
      if (target?.isConnected && target === state.composerTextarea) {
        focusComposerInput(target, { preventScroll: true });
      }
    });
  };
  const cancel = () => {
    const target = props.state.composerTextarea;
    props.owner.cancel();
    focus(target);
  };
  const confirm = async () => {
    const owner = props.owner;
    const target = props.state.composerTextarea;
    await owner.confirm();
    if (owner === props.owner && owner.phase === "committed") {
      focus(target);
    }
  };
  const convert = async () => {
    const input = props.state.composerTextarea;
    if (!input) {
      return;
    }
    try {
      const destination = await prepareFileReferenceDestination(input);
      if (input !== props.state.composerTextarea) {
        return;
      }
      props.owner.cancel();
      if (destination) {
        destination.clearReferences();
      } else {
        props.composer.onDraftChange(
          props.composer.getDraft?.() ?? props.composer.draft,
          props.composer.getMentions?.() ?? props.composer.mentions,
          [],
        );
      }
      focus(input);
    } catch {
      if (input === props.state.composerTextarea) {
        props.owner.cancel("conversion-failed");
      }
    }
  };
  return (
    <section class="composer-file-references">
      <label class="composer-file-references__option">
        <input
          type="checkbox"
          checked={read().enabled}
          disabled={!props.composer.connected || props.composer.canCompose === false}
          onChange={(event) => props.owner.enable(event.currentTarget.checked)}
        />
        {t("chat.fileReferences.enable")}
      </label>
      <Show when={(props.composer.getFileReferences?.() ?? props.composer.fileReferences)?.length}>
        <button type="button" class="btn btn--small" onClick={() => void convert()}>
          {t("chat.fileReferences.convert")}
        </button>
      </Show>
      <Show when={read().enabled}>
        <p class="muted">{t("chat.fileReferences.instructions")}</p>
        <p class="muted">{t("chat.fileReferences.privacy")}</p>
        <label class="composer-file-references__option">
          <input
            type="checkbox"
            checked={read().literal}
            onChange={(event) => props.owner.setLiteral(event.currentTarget.checked)}
          />
          {t("chat.fileReferences.literal")}
        </label>
        <label class="composer-file-references__option">
          <input
            type="checkbox"
            checked={read().commandMode}
            onChange={(event) => props.owner.setCommandMode(event.currentTarget.checked)}
          />
          {t("chat.fileReferences.commandMode")}
        </label>
      </Show>
      <Show when={read().phase !== "idle"}>
        <p role="status" aria-live="polite">
          {read().phase === "choosing" && read().candidates.length
            ? t("chat.fileReferences.results", { count: String(read().candidates.length) })
            : t(`chat.fileReferences.${phaseCopy[read().phase]}`)}
        </p>
      </Show>
      <Show when={read().open}>
        <div
          class="composer-file-references__review"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          }}
        >
          <h3>{t("chat.fileReferences.title")}</h3>
          <p>
            {t("chat.fileReferences.progress", {
              current: String(read().commandNumber),
              total: String(read().commandCount),
            })}
          </p>
          <label>
            {t("chat.fileReferences.query")}
            <input
              type="text"
              value={read().query}
              maxlength="2048"
              spellcheck="false"
              disabled={read().busy || read().phase === "outcome-unknown"}
              onInput={(event) => props.owner.setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void props.owner.search();
                }
              }}
            />
          </label>
          <button
            type="button"
            class="btn btn--small"
            disabled={read().busy || read().phase === "outcome-unknown"}
            onClick={() => void props.owner.search()}
          >
            {t("chat.fileReferences.search")}
          </button>
          <fieldset
            class="composer-file-references__candidates"
            disabled={read().busy || read().phase === "outcome-unknown"}
          >
            <legend>{t("chat.fileReferences.selected")}</legend>
            <For each={read().candidates}>
              {(candidate) => (
                <div class="composer-file-references__candidate">
                  <label>
                    <input
                      type="radio"
                      name={`${props.composer.paneId}-file-reference`}
                      checked={read().selected?.objectId === candidate.reference.objectId}
                      onChange={() => props.owner.select(candidate.reference.objectId)}
                    />
                    <bdi>{fileReferenceText(candidate.reference).slice(1)}</bdi>
                  </label>
                  <details>
                    <summary>{t("chat.fileReferences.inspect")}</summary>
                    <p>
                      <bdi>{candidate.reference.rootLabel}</bdi>
                    </p>
                    <code dir="auto">{fileReferenceText(candidate.reference).slice(1)}</code>
                  </details>
                </div>
              )}
            </For>
          </fieldset>
          <Show when={!read().indexComplete && read().capability}>
            <p>{t("chat.fileReferences.incomplete")}</p>
          </Show>
          <Show when={read().nextCursor}>
            <button
              type="button"
              class="btn btn--small"
              disabled={read().busy}
              onClick={() => void props.owner.search(true)}
            >
              {t("chat.fileReferences.more")}
            </button>
          </Show>
          <Show when={!read().supportsBinding}>
            <p>{t("chat.fileReferences.copyOnly")}</p>
          </Show>
          <openclaw-modal-actions>
            <button type="button" class="btn" onClick={cancel}>
              {t("chat.fileReferences.cancel")}
            </button>
            <button
              type="button"
              class="btn"
              disabled={!read().selected || read().busy || read().phase === "outcome-unknown"}
              onClick={() => void props.owner.copy(false)}
            >
              {t("chat.fileReferences.copyPath")}
            </button>
            <button
              type="button"
              class="btn"
              disabled={!read().selected || read().busy || read().phase === "outcome-unknown"}
              onClick={() => void props.owner.copy(true)}
            >
              {t("chat.fileReferences.copyReference")}
            </button>
            <Show when={read().supportsBinding}>
              <button
                type="button"
                class="btn primary"
                disabled={!read().selected || read().busy || read().phase === "outcome-unknown"}
                onClick={() => void confirm()}
              >
                {t("chat.fileReferences.insert")}
              </button>
            </Show>
          </openclaw-modal-actions>
        </div>
      </Show>
    </section>
  );
}
