import type { ContentBlock } from "@modelcontextprotocol/client";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import {
  releaseChatAttachmentPayloads,
  registerChatAttachmentPayload,
  generateAttachmentId,
} from "../pages/chat/attachment-payload-store.ts";
import {
  resolveChatAttachmentLimits,
  admitAttachmentFiles,
} from "../pages/chat/components/chat-attachment-admission.ts";
import { encodeTextAsDataUrl } from "../pages/chat/components/chat-attachment-text.ts";
import { chatAttachmentFromDataUrl } from "../pages/chat/components/chat-attachments.ts";
import { base64ToBytes } from "./bytes-base64.ts";
import type { ChatAttachment } from "./chat/chat-types.ts";
import { mcpAppMessageText } from "./mcp-app-message-content.ts";

registerMcpAppEnglish();

/** Translate only supported content; never drop an unknown block from a successful send. */
export function mcpAppMessageInput(
  content: ContentBlock[],
  context: Pick<ApplicationContext, "gateway">,
) {
  const text = mcpAppMessageText(content);
  const attachments: ChatAttachment[] = [];
  let bytes = 0;
  const attachFile = (file: File, dataUrl: () => string, fileName: string, origin?: "file") => {
    if (
      !admitAttachmentFiles(
        [file],
        resolveChatAttachmentLimits(context.gateway.snapshot.hello?.policy),
        bytes,
      ).length
    ) {
      throw new Error(t("mcpApp.errors.requestFailed"));
    }
    attachments.push(
      registerChatAttachmentPayload({
        attachment: {
          id: generateAttachmentId(),
          ...(origin ? { origin } : {}),
          mimeType: file.type,
          fileName,
          sizeBytes: file.size,
        },
        dataUrl: dataUrl(),
        file,
      }),
    );
    bytes += file.size;
  };
  const attachText = (value: string, title: string) =>
    attachFile(
      new File([value], title, { type: "text/plain" }),
      () => encodeTextAsDataUrl(value),
      title,
      "file",
    );
  try {
    for (const block of content) {
      const title = block._meta?.["openai/title"];
      if (block.type === "text") {
        if (typeof title === "string" && title.trim()) {
          attachText(block.text, title.trim());
        }
      } else if (block.type === "resource_link") {
        // Keep the resource descriptor as user-supplied data, not prose instructions.
        attachText(JSON.stringify(block, null, 2), block.title?.trim() || block.name);
      } else if (block.type === "resource" && "text" in block.resource) {
        attachText(
          JSON.stringify(block.resource, null, 2),
          typeof title === "string" && title.trim() ? title.trim() : block.resource.uri,
        );
      } else if (block.type === "resource" && "blob" in block.resource) {
        const resource = block.resource;
        const binary = base64ToBytes(resource.blob);
        const file = new File(
          [binary],
          typeof title === "string"
            ? title
            : resource.uri.split("/").at(-1) || t("mcpApp.resourceContent"),
          { type: resource.mimeType || "application/octet-stream" },
        );
        attachFile(file, () => `data:${file.type};base64,${resource.blob}`, file.name);
      } else if (block.type === "image") {
        const attachment = chatAttachmentFromDataUrl(
          `data:${block.mimeType};base64,${block.data}`,
          typeof title === "string" ? title : t("mcpApp.imageContent"),
          resolveChatAttachmentLimits(context.gateway.snapshot.hello?.policy),
          bytes,
        );
        if (!attachment) {
          throw new Error(t("mcpApp.errors.requestFailed"));
        }
        bytes += attachment.sizeBytes ?? 0;
        attachments.push(attachment);
      } else {
        throw new Error(t("mcpApp.errors.requestFailed"));
      }
    }
    return { text, attachments, createdAt: Date.now() };
  } catch (error) {
    releaseChatAttachmentPayloads(attachments);
    throw error;
  }
}
