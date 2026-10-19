import type { JSX } from "@solidjs/web";
import { createMemo, Errored, lazy, Loading, Show } from "solid-js";
import "../../styles/chat/startup-layout.css";
import "../../styles/chat/message-layout.css";
import "../../styles/chat/text.css";
import "../../styles/chat/grouped.css";
import "../../styles/chat/working-indicator.css";
import { beginNativeWindowDragFromTopInset } from "../../app/native-window-drag.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { LoadingState } from "../../components/solid/loading-state.tsx";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { resolveChatDefaultAvatarPlacement } from "../chat/components/chat-author-avatar.ts";
import type { buildLocalUserMessage } from "../chat/user-message-content.ts";

registerEnglishCatalog(registerNewSessionSetupEnglish);

const NewSessionSubmission = lazy(() => import("./draft-submission-view.tsx"), {
  export: "NewSessionSubmission",
});

type DraftAction = { label: string; onClick: () => void; disabled?: boolean };
export type DraftErrorProps = { message: string; action?: DraftAction };
export type NewSessionBodyProps = {
  error: string | null;
  errorAction?: DraftAction;
  pendingMessage: ReturnType<typeof buildLocalUserMessage>;
  userId?: string | null;
  submitting: boolean;
  statusLabel?: string;
  completion?: { label: string; onOpen?: () => void; disabled?: boolean };
  showDraft?: boolean;
  inChat?: boolean;
  hideAnnouncement?: boolean;
  renderDraft: () => JSX.Element;
  onOpenImage: (item: ImageLightboxItem) => void;
};

function newSessionAnnouncement(
  props: Pick<NewSessionBodyProps, "pendingMessage" | "completion" | "statusLabel">,
) {
  return props.pendingMessage
    ? (props.completion?.label ?? props.statusLabel ?? t("newSession.starting"))
    : undefined;
}

export function DraftError(props: DraftErrorProps) {
  return (
    <div class="callout danger new-session-page__error new-session-page__alert" role="alert">
      <span class="new-session-page__alert-icon" aria-hidden="true">
        <Icon name="alertTriangle" />
      </span>
      <span class="callout__content new-session-page__alert-message">
        {formatUiError(props.message)}
      </span>
      <Show when={props.action}>
        {(action) => (
          <button
            class="btn btn--sm"
            type="button"
            disabled={action().disabled}
            onClick={() => action().onClick()}
          >
            {action().label}
          </button>
        )}
      </Show>
    </div>
  );
}

export function NewSessionBody(props: NewSessionBodyProps) {
  const avatarPlacement = createMemo(() =>
    resolveChatDefaultAvatarPlacement(
      true,
      props.pendingMessage && normalizeMessage(props.pendingMessage).sender ? props.userId : null,
    ),
  );
  // Late cleanup can fail while a replacement submission is still pending.
  return (
    <>
      <Show when={!props.hideAnnouncement}>
        <div class="sr-only" role="status" aria-live="polite">
          {newSessionAnnouncement(props)}
        </div>
      </Show>
      <div
        class={[
          props.inChat ? "" : "new-session-page__scroll",
          {
            "chat-thread": Boolean(props.pendingMessage || props.inChat),
            "chat-thread--direct":
              Boolean(props.pendingMessage || props.inChat) && avatarPlacement() === "footer",
          },
        ]}
        inert={props.submitting && !props.pendingMessage}
        aria-busy={props.submitting ? "true" : "false"}
        onMouseDown={beginNativeWindowDragFromTopInset}
      >
        <Show when={props.error}>
          {(error) => <DraftError message={error()} action={props.errorAction} />}
        </Show>
        <Show when={props.pendingMessage} fallback={props.renderDraft()}>
          {(message) => (
            <Errored
              fallback={(error, reset) => <LazyViewError error={error()} onRetry={reset} inline />}
            >
              <Loading fallback={<LoadingState />}>
                <NewSessionSubmission
                  message={message()}
                  avatarPlacement={avatarPlacement()}
                  onOpenImage={props.onOpenImage}
                  statusLabel={props.statusLabel}
                  completion={props.completion}
                />
              </Loading>
            </Errored>
          )}
        </Show>
        <Show when={props.pendingMessage && props.showDraft}>{props.renderDraft()}</Show>
      </div>
    </>
  );
}
