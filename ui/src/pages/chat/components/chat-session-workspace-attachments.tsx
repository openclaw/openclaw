import type { JSX } from "@solidjs/web";
import { createMemo, For, onSettled, refresh, Show, useContext } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { imageHasTitle } from "./chat-image-presentation.ts";
import { MessageAttachmentAction } from "./chat-message-attachments-solid.tsx";
import { MessageImageAction } from "./chat-message-images-solid.tsx";
import type { MessageMediaAction } from "./chat-message-media-actions.ts";
import {
  observeChatMediaResourceSubscriber,
  releaseChatMediaResourceOwner,
  schedulePairingQrExpiryRefresh,
} from "./chat-message-media.ts";
import { splitWorkspaceFilename } from "./chat-session-workspace-catalog.ts";
import { WorkspaceTileBody } from "./chat-session-workspace-row.tsx";
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

/**
 * Filtered transcript attachments plus the pairing-QR expiry lifetime and coverage
 * notice they share, for any catalog that lists them.
 */
export function createTranscriptAttachmentsView(
  source: () => TranscriptAttachments | undefined,
  query: () => string,
) {
  const current = createMemo(() => {
    const value = source();
    // A hidden catalog may remount after expiry without a new transcript publication.
    return value?.pairingQrExpirations.some(
      ({ nextPairingQrExpiresAt }) => nextPairingQrExpiresAt <= Date.now(),
    )
      ? value.refresh()
      : value;
  });
  const refreshMedia = () => void refresh(current);
  function ExpiryLifetime(lifetimeProps: { source: TranscriptAttachments }) {
    onSettled(() => {
      const value = lifetimeProps.source;
      if (!value.pairingQrExpirations.length) {
        return undefined;
      }
      observeChatMediaResourceSubscriber(value.mediaOwner, refreshMedia);
      for (const { messageKey, nextPairingQrExpiresAt } of value.pairingQrExpirations) {
        schedulePairingQrExpiryRefresh(messageKey, nextPairingQrExpiresAt, refreshMedia);
      }
      // Retire only this catalog subscriber, never the pane or an independent reader.
      return () => releaseChatMediaResourceOwner(refreshMedia);
    });
    return null;
  }
  const entries = createMemo(
    () => current()?.entries.filter((entry) => transcriptAttachmentMatches(entry, query())) ?? [],
  );
  const notice = () => {
    const value = current();
    if (!value) {
      return undefined;
    }
    return (
      value.error ??
      (value.loading
        ? t("chat.workspaceFiles.attachmentsLoading")
        : value.coverage === "unknown"
          ? t("chat.workspaceFiles.attachmentsUnknown")
          : value.coverage === "partial" || value.omittedMedia
            ? t("chat.workspaceFiles.attachmentsPartial")
            : undefined)
    );
  };
  return {
    source: current,
    entries,
    notice,
    Lifetime: () => (
      <Show when={current()} keyed>
        {(value) => <ExpiryLifetime source={value} />}
      </Show>
    ),
  };
}

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
  const view = createTranscriptAttachmentsView(
    () => props.source,
    () => props.query,
  );
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
      <view.Lifetime />
      <Show when={props.presentation === "mobile" && (view.entries().length || view.notice())}>
        <div class="chat-workspace-mobile__group-heading">
          {t("chat.workspaceFiles.attachments")}
        </div>
      </Show>
      <For each={view.entries()} keyed={(entry) => entry.key}>
        {(entry) => (
          <TranscriptAttachmentRow
            entry={entry()}
            presentation={props.presentation}
            renderName={props.renderName}
          />
        )}
      </For>
      <Show when={view.notice()}>
        {(message) => (
          <div
            role={view.source()?.error ? "alert" : "status"}
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

export function TranscriptAttachmentRow(props: {
  entry: TranscriptAttachmentEntry;
  presentation: "desktop" | "mobile";
  /** Desktop catalogs can show a tile instead of a row. */
  view?: "list" | "grid";
  renderName?: (name: string) => JSX.Element;
}) {
  const render = (action: () => MessageMediaAction) => <AttachmentActionRow action={action} />;
  function AttachmentActionRow(childProps: { action: () => MessageMediaAction }) {
    const mobile = () => props.presentation === "mobile";
    const grid = () => !mobile() && props.view === "grid";
    const parts = createMemo(() => splitWorkspaceFilename(props.entry.label));
    // Untitled transcript images carry only the generic fallback title; the tile speaks for itself.
    const captioned = () => props.entry.kind !== "image" || imageHasTitle(props.entry.image);
    return (
      <div
        role="listitem"
        class={
          mobile()
            ? "chat-workspace-mobile__item"
            : grid()
              ? "workspace-desktop__tile-item"
              : "workspace-desktop__item"
        }
      >
        <button
          type="button"
          class={
            mobile()
              ? "chat-workspace-mobile__row"
              : grid()
                ? "workspace-desktop__tile"
                : "workspace-desktop__row"
          }
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
          <Show
            when={grid()}
            fallback={
              <>
                <Show when={!mobile()}>
                  <span class="workspace-desktop__disclosure" />
                </Show>
                <Icon
                  class={
                    mobile()
                      ? "chat-workspace-mobile__file-icon"
                      : "workspace-desktop__attachment-icon"
                  }
                  name={
                    props.entry.kind === "image" || props.entry.mimeType?.startsWith("image/")
                      ? "image"
                      : "paperclip"
                  }
                />
                <span
                  class={
                    mobile() ? "chat-workspace-mobile__identity" : "workspace-desktop__identity"
                  }
                >
                  <Show
                    when={props.renderName}
                    fallback={
                      <span
                        class={
                          mobile() ? "chat-workspace-mobile__name" : "workspace-desktop__filename"
                        }
                      >
                        <span
                          ref={createTextOverflow(() => parts().stem)}
                          class={
                            mobile() ? "chat-workspace-mobile__stem" : "workspace-desktop__stem"
                          }
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
              </>
            }
          >
            <WorkspaceTileBody
              name={props.entry.label}
              mimeType={
                props.entry.mimeType ?? (props.entry.kind === "image" ? "image/png" : undefined)
              }
              previewUrl={childProps.action().previewUrl}
              caption={captioned()}
            />
          </Show>
        </button>
        <Show when={childProps.action().reason}>
          {(reason) => <span role="status">{reason()}</span>}
        </Show>
        <Show when={childProps.action().onFindWorkspaceFile}>
          <button
            type="button"
            aria-label={t("chat.attachments.findInFilesFor", { name: props.entry.label })}
            onClick={() => childProps.action().onFindWorkspaceFile?.()}
          >
            {t("chat.attachments.findInFiles")}
          </button>
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
