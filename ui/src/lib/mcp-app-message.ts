import type { ContentBlock } from "@modelcontextprotocol/client";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { McpAppMessageEventDetail } from "../components/mcp-app-security.ts";
import { t } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { buildChatApiAttachments } from "../pages/chat/attachment-api.ts";
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
import { completeInitialSessionTurn } from "../pages/new-session/initial-session-turn-handoff.ts";
import { StartedSessionNavigation } from "../pages/new-session/started-session-navigation.ts";
import type { ChatAttachment } from "./chat/chat-types.ts";
import { mcpAppMessageText } from "./mcp-app-message-content.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "./uploads.ts";

registerMcpAppEnglish();

/** Translate only supported content; never drop an unknown block from a successful send. */
export function mcpAppMessageInput(
  content: ContentBlock[],
  context: Pick<ApplicationContext, "gateway">,
) {
  const text = mcpAppMessageText(content);
  const attachments: ChatAttachment[] = [];
  let bytes = 0;
  const attachText = (value: string, title: string) => {
    const file = new File([value], title, { type: "text/plain" });
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
          origin: "file",
          mimeType: file.type,
          fileName: title,
          sizeBytes: file.size,
        },
        dataUrl: encodeTextAsDataUrl(value),
        file,
      }),
    );
    bytes += file.size;
  };
  try {
    for (const block of content) {
      if (block.type === "text") {
        const title = block._meta?.["openai/title"];
        if (typeof title === "string" && title.trim()) {
          attachText(block.text, title.trim());
        }
      } else if (block.type === "resource_link") {
        // Keep the resource descriptor as user-supplied data, not prose instructions.
        attachText(JSON.stringify(block, null, 2), block.title?.trim() || block.name);
      } else if (block.type === "resource" && "text" in block.resource) {
        const title = block._meta?.["openai/title"];
        attachText(
          JSON.stringify(block.resource, null, 2),
          typeof title === "string" && title.trim() ? title.trim() : block.resource.uri,
        );
      } else if (block.type === "resource" && "blob" in block.resource) {
        const resource = block.resource;
        const binary = Uint8Array.from(atob(resource.blob), (character) => character.charCodeAt(0));
        const title = block._meta?.["openai/title"];
        const file = new File(
          [binary],
          typeof title === "string"
            ? title
            : resource.uri.split("/").at(-1) || t("mcpApp.resourceContent"),
          { type: resource.mimeType || "application/octet-stream" },
        );
        if (
          !admitAttachmentFiles(
            [file],
            resolveChatAttachmentLimits(context.gateway.snapshot.hello?.policy),
            bytes,
          ).length
        ) {
          throw new Error(t("mcpApp.errors.requestFailed"));
        }
        const attachment = registerChatAttachmentPayload({
          attachment: {
            id: generateAttachmentId(),
            mimeType: file.type,
            fileName: file.name,
            sizeBytes: file.size,
          },
          dataUrl: `data:${file.type};base64,${resource.blob}`,
          file,
        });
        attachments.push(attachment);
        bytes += file.size;
      } else if (block.type === "image") {
        const title = block._meta?.["openai/title"];
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

export async function sendMcpAppNewConversation(
  context: ApplicationContext,
  agentId: string,
  detail: McpAppMessageEventDetail,
): Promise<boolean> {
  const client = context.gateway.snapshot.client;
  if (!client || context.gateway.snapshot.phase !== "connected") {
    return false;
  }
  const scope = gatewayPresentationScope(context.gateway).key;
  const location = context.router.getState().location;
  const intent = context.agentSelection.intentRevision;
  const turn = mcpAppMessageInput(detail.content, context);
  if (turn.attachments.length && !uploadsEnabled(context.config)) {
    releaseChatAttachmentPayloads(turn.attachments);
    throw new Error(uploadsDisabledMessage());
  }
  const current = () =>
    context.gateway.snapshot.client === client &&
    gatewayPresentationScope(context.gateway).key === scope &&
    context.router.getState().location === location &&
    context.agentSelection.intentRevision === intent;
  let released = false;
  try {
    const result = await context.sessions.createResult({
      agentId,
      message: turn.text,
      attachments: buildChatApiAttachments(turn.attachments),
    });
    if (!result) {
      return false;
    }
    const navigation = new StartedSessionNavigation();
    await completeInitialSessionTurn({
      context,
      client,
      agentId,
      result,
      turn,
      navigation,
      instant: undefined,
      isCurrent: current,
      clearDraft: async (release) => {
        released = true;
        if (release) {
          releaseChatAttachmentPayloads(turn.attachments);
        }
      },
      completeInBackground: () => false,
      finishNavigation: () => {},
    });
    return result.initialRun.status === "started";
  } finally {
    if (!released) {
      releaseChatAttachmentPayloads(turn.attachments);
    }
  }
}
