import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, createSignal, For, Loading, onCleanup, Show } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { readAttachmentText } from "./chat-attachment-text-reader.ts";
import { parseCommentAttachment, type CommentPreview } from "./chat-comment-preview.ts";
import { CommentPreviewChip, CommentPreviewRow } from "./chat-comment-preview.tsx";
import {
  needsAttachmentSourceAdmission,
  type AttachmentAdmission,
} from "./chat-message-attachment-admission-model.ts";
import { createChatAttachmentAdmission } from "./chat-message-attachment-admission-solid.tsx";
import type { AttachmentItem, ImageRenderOptions } from "./chat-message-media.ts";

registerEnglishCatalog(registerChatComposerEnglish);

type SentCommentSource = {
  identity: string;
  src?: string;
  sizeBytes?: number;
  pending?: boolean;
  fallback: () => SolidJSX.Element;
};
type Props = {
  comments: AttachmentItem[];
  inline?: boolean;
  options: ImageRenderOptions;
  resolve: (item: AttachmentItem) => SentCommentSource;
};

export function SentCommentAttachments(props: Props) {
  const authority = () =>
    JSON.stringify([
      props.options.sessionKey,
      props.options.agentId,
      props.options.connectionEpoch,
      props.options.resourceBasePath,
      props.options.authToken,
      props.options.policyKey,
      props.comments.map(({ attachment }) => [attachment.kind, attachment.label]),
      props.options.messageSendId ??
        props.options.canonicalMessageKey ??
        props.options.messageId ??
        props.comments.map((item) => item.attachment.url),
    ]);
  return (
    <Show when={props.comments.length && authority()} keyed>
      {(_authority) => <AdmittedComments {...props} />}
    </Show>
  );
}

function AdmittedComments(props: Props) {
  const admission = createChatAttachmentAdmission(
    () =>
      JSON.stringify(
        props.comments.map((item) => [item.attachment.url, item.attachment.artifactId]),
      ),
    () => !props.comments.some((item) => needsAttachmentSourceAdmission(item.attachment)),
  );
  return (
    <SentComments
      inline={props.inline}
      sources={props.comments.map((item) =>
        admission.admitted
          ? props.resolve(item)
          : { identity: item.attachment.url, pending: true, fallback: () => undefined },
      )}
      scope={JSON.stringify([props.options.messageId, props.options.canonicalMessageKey])}
      admission={admission}
    />
  );
}

function SentComments(props: {
  sources: SentCommentSource[];
  inline?: boolean;
  scope: string;
  admission?: AttachmentAdmission;
}) {
  const sources = () => props.sources;
  const inline = createMemo(() => Boolean(props.inline));
  const [revealed, setRevealed] = createSignal(false);
  // Ignore fallback JSX identity: sibling cards must not restart these reads.
  const request = createMemo(
    () => {
      const current = sources();
      return {
        key: JSON.stringify([
          props.scope,
          current.map(({ fallback: _fallback, ...source }) => source),
        ]),
        sources: current,
      };
    },
    { equals: (before, next) => before.key === next.key },
  );
  const comments = createMemo<Array<CommentPreview | null | undefined>>((previous) => {
    const current = request().sources;
    let values: Array<CommentPreview | null | undefined> = current.map((source, index) =>
      !source.src && !source.pending ? null : previous?.[index],
    );
    if (!inline() && !revealed()) {
      return values;
    }
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    const pending = new Map<number, Promise<{ index: number; comment: CommentPreview | null }>>();
    current.forEach((source, index) => {
      if (source.src) {
        pending.set(
          index,
          readAttachmentText(source.src, source.sizeBytes, controller.signal)
            .then(
              (text) => parseCommentAttachment(text),
              () => null,
            )
            .then((comment) => ({ index, comment })),
        );
      }
    });
    // A source handoff retains the committed quote until its replacement read settles.
    return (async function* () {
      yield values;
      while (pending.size) {
        const { index, comment } = await Promise.race(pending.values());
        pending.delete(index);
        if (controller.signal.aborted) {
          return;
        }
        values = values.map((value, i) => (i === index ? comment : value));
        yield values;
      }
    })();
  });
  const count = () => sources().filter((_, index) => comments()[index] !== null).length;
  return (
    <openclaw-chat-sent-comments style={{ display: "contents" }}>
      <Loading>
        <Show
          when={inline()}
          fallback={
            <Show when={count()}>
              <CommentPreviewChip
                count={count()}
                onReveal={() => {
                  setRevealed(true);
                  props.admission?.onAdmit();
                }}
                elementRef={props.admission?.observeElement}
              >
                <ol class="chat-comment-preview__list" role="list">
                  <For each={sources()} keyed={false}>
                    {(_source, index) => (
                      <Show
                        when={comments()[index]}
                        fallback={
                          comments()[index] === null ? undefined : (
                            <li class="chat-comment-preview__item muted">{t("common.loading")}</li>
                          )
                        }
                      >
                        {(comment) => <CommentPreviewRow comment={comment()} />}
                      </Show>
                    )}
                  </For>
                </ol>
              </CommentPreviewChip>
            </Show>
          }
        >
          <div class="chat-sent-comments-inline" ref={props.admission?.observeElement}>
            <For each={sources()} keyed={false}>
              {(_source, index) => (
                <Show
                  when={comments()[index]}
                  fallback={
                    comments()[index] === undefined ? (
                      <span class="muted">{t("common.loading")}</span>
                    ) : undefined
                  }
                >
                  {(comment) => (
                    <div class="chat-sent-comments-inline__item">
                      <blockquote aria-label={t("chat.messages.annotationSelectedText")}>
                        <openclaw-tooltip
                          class="chat-comment-preview"
                          prop:placement="top-start"
                          prop:autoSize={true}
                          prop:describe={false}
                          prop:openOnClick={true}
                        >
                          <button type="button" class="chat-sent-comments-inline__selection">
                            {comment().text}
                          </button>
                          <div
                            slot="content"
                            class="chat-comment-preview__scroll"
                            tabindex={0}
                            role="region"
                            aria-label={t("chat.messages.annotationSelectedText")}
                          >
                            {comment().text}
                          </div>
                        </openclaw-tooltip>
                      </blockquote>
                      <Show when={comment().comment}>
                        <div class="chat-sent-comments-inline__comment">{comment().comment}</div>
                      </Show>
                    </div>
                  )}
                </Show>
              )}
            </For>
          </div>
        </Show>
        <For each={sources()} keyed={false}>
          {(source, index) => <Show when={comments()[index] === null}>{source().fallback()}</Show>}
        </For>
      </Loading>
    </openclaw-chat-sent-comments>
  );
}
