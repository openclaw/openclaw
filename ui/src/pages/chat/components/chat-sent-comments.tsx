import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { readAttachmentText } from "./chat-attachment-text-reader.ts";
import { parseCommentAttachment, type CommentPreview } from "./chat-comment-preview.ts";
import { CommentPreviewChip, CommentPreviewRow } from "./chat-comment-preview.tsx";
import {
  needsAttachmentSourceAdmission,
  type AttachmentAdmission,
} from "./chat-message-attachment-admission-model.ts";
import { ChatAttachmentAdmission } from "./chat-message-attachment-admission-solid.tsx";
import type { AttachmentItem, ImageRenderOptions } from "./chat-message-media.ts";

type SentCommentSource = {
  identity: string;
  src?: string;
  sizeBytes?: number;
  pending?: boolean;
  fallback: () => SolidJSX.Element;
};
type Props = {
  comments: AttachmentItem[];
  options: ImageRenderOptions;
  resolve: (item: AttachmentItem) => SentCommentSource;
};

export function SentCommentAttachments(props: Props) {
  const renderComments = (admission?: AttachmentAdmission) => (
    <SentComments
      sources={props.comments.map((item) =>
        admission?.observeElement
          ? { identity: item.attachment.url, pending: true, fallback: () => undefined }
          : props.resolve(item),
      )}
      scope={JSON.stringify([
        props.options.sessionKey,
        props.options.agentId,
        props.options.messageId,
        props.options.connectionEpoch,
        props.options.resourceBasePath,
        props.options.authToken,
        props.options.policyKey,
      ])}
      admission={admission}
    />
  );
  return (
    <Show when={props.comments.length}>
      <Show
        when={props.comments.some((item) => needsAttachmentSourceAdmission(item.attachment))}
        fallback={renderComments()}
      >
        <ChatAttachmentAdmission
          attachments={props.comments.map((item) => item.attachment)}
          options={props.options}
          render={renderComments}
        />
      </Show>
    </Show>
  );
}

function SentComments(props: {
  sources: SentCommentSource[];
  scope: string;
  admission?: AttachmentAdmission;
}) {
  const sources = createMemo(() => props.sources);
  const [revealed, setRevealed] = createSignal(false);
  // Ignore fallback JSX identity: sibling cards must not restart these reads.
  const key = createMemo(() =>
    JSON.stringify([props.scope, sources().map(({ fallback: _fallback, ...source }) => source)]),
  );
  const [comments, setComments] = createSignal<Array<CommentPreview | null | undefined>>(() => {
    key();
    return untrack(() =>
      sources().map((source) => (!source.src && !source.pending ? null : undefined)),
    );
  });
  createEffect(
    () => ({ key: key(), revealed: revealed(), current: untrack(sources) }),
    ({ revealed: wasRevealed, current: requestSources }) => {
      if (!wasRevealed) {
        return undefined;
      }
      const controller = new AbortController();
      requestSources.forEach((source, index) => {
        if (!source.src) {
          return;
        }
        void readAttachmentText(source.src, source.sizeBytes, controller.signal)
          .then(
            (text) => parseCommentAttachment(text),
            () => null,
          )
          .then((comment) => {
            if (!controller.signal.aborted) {
              setComments((previous) =>
                previous.map((value, i) => (i === index ? comment : value)),
              );
            }
          });
      });
      return () => controller.abort();
    },
  );
  const count = () => sources().filter((_, index) => comments()[index] !== null).length;
  return (
    <openclaw-chat-sent-comments style={{ display: "contents" }}>
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
              {(source, index) => (
                <Show
                  when={comments()[index]}
                  fallback={
                    comments()[index] === null ? undefined : (
                      <li class="chat-comment-preview__item muted">
                        {source().src || source().pending
                          ? t("common.loading")
                          : t("chat.attachments.textPreviewUnavailable")}
                      </li>
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
      <For each={sources()} keyed={false}>
        {(source, index) => <Show when={comments()[index] === null}>{source().fallback()}</Show>}
      </For>
    </openclaw-chat-sent-comments>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-sent-comments": HTMLAttributes<HTMLElement>;
    }
  }
}
