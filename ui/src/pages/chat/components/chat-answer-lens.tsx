import { For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { createAnswerLensProjection } from "../../../lib/reactive/answer-lens.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { ORIGINAL_LENS, type AnswerLens, type AnswerLensSource } from "../answer-lens.ts";

registerEnglishCatalog(registerChatMessageMetadataEnglish);
const LEVELS = {
  coverage: [{ coverage: "full" }, { coverage: "condensed" }, { coverage: "gist" }],
  wording: [{ wording: "technical" }, { wording: "clearer" }, { wording: "plain" }],
} as const;

type Props = {
  owner: AnswerLens;
  source: AnswerLensSource;
  axis: "coverage" | "wording";
  onSelect: () => void;
};

export function AnswerLensControls(props: Props) {
  const entry = createAnswerLensProjection(
    () => props.owner,
    () => props.source,
  );
  return (
    <>
      <div
        class="answer-lens__levels"
        role="group"
        aria-label={t(`chat.messages.answerLens.${props.axis}Label`)}
      >
        <For each={LEVELS[props.axis]}>
          {(level) => {
            const value = "coverage" in level ? level.coverage : level.wording;
            return (
              <button
                type="button"
                class="oc-menu-item answer-lens__point"
                aria-label={t(`chat.messages.answerLens.${props.axis}.${value}`)}
                title={t(`chat.messages.answerLens.${props.axis}.${value}`)}
                aria-pressed={
                  (entry()?.target ?? ORIGINAL_LENS)[props.axis] === value ? "true" : "false"
                }
                disabled={
                  props.axis === "coverage" && props.source.text.length < 160 && value !== "full"
                }
                // Keep pointer focus on the trigger: focusing a portaled option can
                // scroll the transcript and move its anchor before pointerup.
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  const current = props.owner.read(props.source)?.target ?? ORIGINAL_LENS;
                  void props.owner.select(props.source, {
                    ...current,
                    wording: current.wording === "original" ? "technical" : current.wording,
                    ...level,
                  });
                  props.onSelect();
                }}
              >
                <span class="oc-menu-item__label">
                  {t(`chat.messages.answerLens.${props.axis}.${value}`)}
                </span>
                <span class="oc-menu-item__check" aria-hidden="true">
                  <Show when={(entry()?.target ?? ORIGINAL_LENS)[props.axis] === value}>
                    <Icon name="check" />
                  </Show>
                </span>
              </button>
            );
          }}
        </For>
      </div>
      <Show when={entry()?.error}>
        <p class="muted" role="alert">
          {entry()?.error}
        </p>
        <button
          type="button"
          class="btn btn--sm"
          onClick={() => void props.owner.select(props.source, entry()?.target ?? ORIGINAL_LENS)}
        >
          {t("common.retry")}
        </button>
      </Show>
    </>
  );
}
