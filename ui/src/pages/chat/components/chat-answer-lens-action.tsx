import { createSignal, createUniqueId, For, lazy, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Popover } from "../../../components/solid/popover.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { createAnswerLensProjection } from "../../../lib/reactive/answer-lens.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { ORIGINAL_LENS, type AnswerLens, type AnswerLensSource } from "../answer-lens.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

registerEnglishCatalog(registerChatMessageMetadataEnglish);
const Controls = lazy(() => import("./chat-answer-lens.tsx"), { export: "AnswerLensControls" });
type Props = { owner: AnswerLens; source: AnswerLensSource };

export function AnswerLensControl(props: Props) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal<"coverage" | "wording" | undefined>(undefined);
  return (
    <For each={["coverage", "wording"] as const}>
      {(axis) => (
        <Popover
          id={`answer-lens-${id}-${axis}`}
          label={t(`chat.messages.answerLens.${axis}Label`)}
          trigger={<Icon name={axis === "coverage" ? "listFilter" : "bookOpenText"} />}
          triggerTitle={t(`chat.messages.answerLens.${axis}Label`)}
          triggerClass="chat-reply-btn answer-lens-trigger"
          placement="top-end"
          class="answer-lens"
          open={open() === axis}
          onOpenChange={(value) => setOpen(value ? axis : undefined)}
          lazy
        >
          <Show when={open() === axis}>
            <ChatLazyBoundary>
              <Controls
                owner={props.owner}
                source={props.source}
                axis={axis}
                onSelect={() => setOpen(undefined)}
              />
            </ChatLazyBoundary>
          </Show>
        </Popover>
      )}
    </For>
  );
}

export function AnswerLensStatus(props: Props) {
  const entry = createAnswerLensProjection(
    () => props.owner,
    () => props.source,
  );
  return (
    <Show when={entry()?.displayed || entry()?.pending || entry()?.error}>
      <div class="answer-lens-status chip" aria-live="polite">
        <span>
          {entry()?.pending
            ? t("chat.messages.answerLens.adjusting")
            : entry()?.error
              ? t("chat.messages.answerLens.failed")
              : `${t(`chat.messages.answerLens.wording.${entry()!.displayed!.wording}`)} · ${t(`chat.messages.answerLens.coverage.${entry()!.displayed!.coverage}`)}`}
        </span>{" "}
        <button
          class="btn btn--xs"
          type="button"
          onClick={() => void props.owner.select(props.source, ORIGINAL_LENS)}
        >
          {t("chat.messages.answerLens.reset")}
        </button>
      </div>
    </Show>
  );
}
