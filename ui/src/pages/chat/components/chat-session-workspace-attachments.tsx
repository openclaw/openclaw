import type { JSX } from "@solidjs/web";
import { createMemo, For, onSettled, refresh, Show, useContext } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { MessageAttachmentAction } from "./chat-message-attachments-solid.tsx";
import { MessageImageAction } from "./chat-message-images-view.tsx";
import {
  observeChatMediaResourceSubscriber,
  releaseChatMediaResourceOwner,
  schedulePairingQrExpiryRefresh,
  type MessageMediaAction,
} from "./chat-message-media.ts";
import { splitWorkspaceFilename } from "./chat-session-workspace-catalog.ts";
import type {
  TranscriptAttachmentEntry,
  TranscriptAttachments,
} from "./chat-sidebar-content-types.ts";
import { transcriptAttachmentMatches } from "./chat-transcript-attachments.ts";

registerEnglishCatalog(registerChatComposerEnglish);

registerEnglishCatalog(registerChatSessionOptionalEnglish);

type WorkspaceTranscriptAttachmentsProps = {
  source: TranscriptAttachments;
  query: string;
  presentation: "desktop" | "mobile";
  renderName?: (name: string) => JSX.Element;
};

export function WorkspaceTranscriptAttachments(
  props: WorkspaceTranscriptAttachmentsProps,
): JSX.Element {
  const presented = useContext(ContentPresentation);
  return (
    <Show when={presented()}>
      <TranscriptAttachmentsContent {...props} />
    </Show>
  );
}

function TranscriptAttachmentsContent(props: WorkspaceTranscriptAttachmentsProps): JSX.Element {
  const source = createMemo(() => {
    const current = props.source;
    // A hidden catalog may remount after expiry without a new transcript publication.
    return current.pairingQrExpirations.some(
      ({ nextPairingQrExpiresAt }) => nextPairingQrExpiresAt <= Date.now(),
    )
      ? current.refresh()
      : current;
  });
  const refreshMedia = () => void refresh(source);
  function ExpiryLifetime(lifetimeProps: { source: TranscriptAttachments }) {
    onSettled(() => {
      const current = lifetimeProps.source;
      if (!current.pairingQrExpirations.length) {
        return undefined;
      }
      observeChatMediaResourceSubscriber(current.mediaOwner, refreshMedia);
      for (const { messageKey, nextPairingQrExpiresAt } of current.pairingQrExpirations) {
        schedulePairingQrExpiryRefresh(messageKey, nextPairingQrExpiresAt, refreshMedia);
      }
      // Retire only this catalog subscriber, never the pane or an independent reader.
      return () => releaseChatMediaResourceOwner(refreshMedia);
    });
    return null;
  }
  const entries = createMemo(() =>
    source().entries.filter((entry) => transcriptAttachmentMatches(entry, props.query)),
  );
  const notice = () =>
    source().error ??
    (source().loading
      ? t("chat.workspaceFiles.attachmentsLoading")
      : source().coverage === "unknown"
        ? t("chat.workspaceFiles.attachmentsUnknown")
        : source().coverage === "partial" || source().omittedMedia
          ? t("chat.workspaceFiles.attachmentsPartial")
          : undefined);
  return (
    <div
      class={
        props.presentation === "desktop"
          ? "workspace-desktop__attachments"
          : "chat-workspace-mobile__group"
      }
      role="list"
      aria-label={t("chat.workspaceFiles.attachments")}
    >
      <Show when={source()} keyed>
        {(current) => <ExpiryLifetime source={current} />}
      </Show>
      <Show when={props.presentation === "mobile" && (entries().length || notice())}>
        <div class="chat-workspace-mobile__group-heading">
          {t("chat.workspaceFiles.attachments")}
        </div>
      </Show>
      <For each={entries()} keyed={(entry) => entry.key}>
        {(entry) => (
          <TranscriptAttachmentRow
            entry={entry()}
            presentation={props.presentation}
            renderName={props.renderName}
          />
        )}
      </For>
      <Show when={notice()}>
        {(message) => (
          <div
            role={source().error ? "alert" : "status"}
            class={
              props.presentation === "desktop"
                ? "workspace-desktop__notice"
                : "chat-workspace-mobile__notice"
            }
          >
            {message()}
          </div>
        )}
      </Show>
    </div>
  );
}

function TranscriptAttachmentRow(props: {
  entry: TranscriptAttachmentEntry;
  presentation: "desktop" | "mobile";
  renderName?: (name: string) => JSX.Element;
}) {
  const render = (action: () => MessageMediaAction) => <AttachmentActionRow action={action} />;
  function AttachmentActionRow(childProps: { action: () => MessageMediaAction }) {
    const mobile = () => props.presentation === "mobile";
    const parts = createMemo(() => splitWorkspaceFilename(props.entry.label));
    return (
      <div
        role="listitem"
        class={mobile() ? "chat-workspace-mobile__item" : "workspace-desktop__item"}
      >
        <button
          type="button"
          class={mobile() ? "chat-workspace-mobile__row" : "workspace-desktop__row"}
          ref={(element) => childProps.action().observeElement?.(element)}
          onFocus={() => childProps.action().onFocus?.()}
          onClick={() => (childProps.action().onOpen ?? childProps.action().onFocus)?.()}
          title={props.entry.label}
          aria-label={props.entry.label}
          aria-busy={childProps.action().pending ? "true" : "false"}
          aria-disabled={
            !childProps.action().onOpen && !childProps.action().onFocus ? "true" : undefined
          }
        >
          <Show when={!mobile()}>
            <span class="workspace-desktop__disclosure" />
          </Show>
          <Icon
            class={
              mobile() ? "chat-workspace-mobile__file-icon" : "workspace-desktop__attachment-icon"
            }
            name={
              props.entry.kind === "image" || props.entry.mimeType?.startsWith("image/")
                ? "image"
                : "paperclip"
            }
          />
          <span
            class={mobile() ? "chat-workspace-mobile__identity" : "workspace-desktop__identity"}
          >
            <Show
              when={props.renderName}
              fallback={
                <span
                  class={mobile() ? "chat-workspace-mobile__name" : "workspace-desktop__filename"}
                >
                  <span
                    ref={createTextOverflow(() => parts().stem)}
                    class={mobile() ? "chat-workspace-mobile__stem" : "workspace-desktop__stem"}
                    title={props.entry.label}
                  >
                    {parts().stem}
                  </span>
                  <span class={mobile() ? "chat-workspace-mobile__extension" : undefined}>
                    {parts().extension}
                  </span>
                </span>
              }
            >
              {(renderName) => renderName()(props.entry.label)}
            </Show>
          </span>
          <Show when={mobile()}>
            <Icon name="chevronRight" class="chat-workspace-mobile__chevron" />
          </Show>
        </button>
        <Show when={childProps.action().reason}>
          {(reason) => <span role="status">{reason()}</span>}
        </Show>
        <Show when={childProps.action().onAllow}>
          <button type="button" onClick={() => childProps.action().onAllow?.()}>
            {t("chat.attachments.allowImage")}
          </button>
        </Show>
        <Show when={childProps.action().onRetry}>
          <button type="button" onClick={() => childProps.action().onRetry?.()}>
            {t("common.retry")}
          </button>
        </Show>
      </div>
    );
  }

  return (
    <Show
      when={props.entry.kind === "image" && props.entry}
      fallback={
        <Show when={props.entry.kind === "attachment" && props.entry}>
          {(entry) => (
            <MessageAttachmentAction
              item={entry().item}
              options={entry().options}
              onOpenSidebar={(content) => entry().onOpenSidebar(content)}
              render={render}
            />
          )}
        </Show>
      }
    >
      {(entry) => (
        <MessageImageAction image={entry().image} options={entry().options} render={render} />
      )}
    </Show>
  );
}
