import type { JSX as SolidJSX } from "@solidjs/web";
import { createMemo, createSignal, For, Loading, onCleanup, Show } from "solid-js";
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
  const sources = () => props.sources;
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
  const comments = createMemo(() => {
    const current = request().sources;
    let values: Array<CommentPreview | null | undefined> = current.map((source) =>
      !source.src && !source.pending ? null : undefined,
    );
    if (!revealed()) {
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
    // Publish each completed attachment independently while retaining cancellation at this read.
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
      </Loading>
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
