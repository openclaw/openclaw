import { html } from "lit";
import { guard } from "lit/directives/guard.js";
import { until } from "lit/directives/until.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { getChatAttachmentVideoPosterUrl } from "../attachment-payload-store.ts";
import { resolveAttachmentFileIcon } from "./chat-attachment-file-icon.ts";

function renderAttachmentVideoPreview(attachment: ChatAttachment) {
  const poster = getChatAttachmentVideoPosterUrl(attachment);
  return html`
    <span class="chat-attachment-file__preview" aria-hidden="true">
      ${guard([poster], () =>
        until(
          poster?.then((src) =>
            src
              ? html`
                  <img src=${src} alt="" />
                  <span class="chat-attachment-video__play">${icons.play}</span>
                `
              : icons.play,
          ) ?? icons.play,
          icons.play,
        ),
      )}
    </span>
  `;
}

export function renderCompactAttachmentFile(attachment: ChatAttachment) {
  const { family, extensionLabel } = resolveAttachmentFileIcon(
    attachment.fileName ?? "attachment",
    attachment.mimeType,
  );
  const name = attachment.fileName ?? t("chat.attachments.attachedFile");
  const glyph = family === "audio" ? icons.music : icons.fileText;
  return html`
    <openclaw-tooltip .content=${name}>
      <div
        class=${`chat-attachment-file${family === "video" ? " chat-attachment-file--video" : ""}`}
      >
        ${
          family === "video"
            ? renderAttachmentVideoPreview(attachment)
            : html`<span class="chat-attachment-file__icon" data-family=${family}>${glyph}</span>`
        }
        <span class="chat-attachment-file__body">
          <span class="chat-attachment-file__name">${name}</span>
          <span class="chat-attachment-file__type">${extensionLabel}</span>
        </span>
      </div>
    </openclaw-tooltip>
  `;
}
