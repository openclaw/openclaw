import type { GatewayBrowserClient } from "../gateway.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { extractText } from "../chat/message-extract.ts";
import { generateUUID } from "../uuid.ts";

export type UploadResult = {
  id: string;
  path: string;
  fileName: string;
  size: number;
  mimeType?: string;
};

type UploadedFileAttachment = {
  type: "file";
  id: string;
  path: string;
  fileName: string;
  size: number;
  mimeType?: string;
};

async function dataUrlToBlob(dataUrl: string): Promise<Blob | null> {
  if (!dataUrl.startsWith("data:")) {
    return null;
  }
  const response = await fetch(dataUrl).catch(() => null);
  if (!response?.ok) {
    return null;
  }
  return await response.blob().catch(() => null);
}

/**
 * Upload a file to the server via HTTP /uploads endpoint.
 */
export async function uploadFileToServer(
  client: GatewayBrowserClient,
  attachment: ChatAttachment,
): Promise<UploadResult> {
  const blob = await dataUrlToBlob(attachment.dataUrl);
  if (!blob) {
    throw new Error("Invalid data URL format");
  }
  const fileName = attachment.fileName || "file";
  const uploadRequest = await client.resolveUploadRequest();
  const { url, authorization } = uploadRequest;
  if (!authorization) {
    throw new Error("Uploads require gateway token/password auth");
  }
  const headers = new Headers({
    Authorization: authorization,
    "X-File-Name": fileName,
  });
  if (typeof uploadRequest.deviceId === "string" && uploadRequest.deviceId.trim()) {
    headers.set("X-OpenClaw-Device-Id", uploadRequest.deviceId.trim());
  }
  if (attachment.mimeType?.trim()) {
    headers.set("Content-Type", attachment.mimeType);
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: blob,
  });
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    id?: string;
    path?: string;
    fileName?: string;
    size?: number;
    mimeType?: string;
    error?: string;
  } | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `Upload failed (${response.status})`);
  }
  const uploadedPath =
    typeof payload.path === "string" && payload.path.trim() ? payload.path.trim() : "";
  if (!uploadedPath) {
    throw new Error("Upload failed: server did not return file path");
  }
  const result: UploadResult = {
    id: payload.id ?? "",
    path: uploadedPath,
    fileName: payload.fileName ?? fileName,
    size: payload.size ?? blob.size,
    mimeType: payload.mimeType,
  };
  return result;
}

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.chatLoading = true;
  state.lastError = null;
  try {
    const res = await state.client.request<{ messages?: Array<unknown>; thinkingLevel?: string }>(
      "chat.history",
      {
        sessionKey: state.sessionKey,
        limit: 200,
      },
    );
    state.chatMessages = Array.isArray(res.messages) ? res.messages : [];
    state.chatThinkingLevel = res.thinkingLevel ?? null;
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.chatLoading = false;
  }
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  let msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }

  const now = Date.now();

  // Separate image and file attachments
  const imageAttachments: ChatAttachment[] = [];
  const fileAttachments: ChatAttachment[] = [];

  if (hasAttachments) {
    for (const att of attachments) {
      if (att.isFile || !att.mimeType?.startsWith("image/")) {
        fileAttachments.push(att);
      } else {
        imageAttachments.push(att);
      }
    }
  }

  // Upload file attachments to server and keep both display notes and structured refs.
  const uploadedFiles: UploadedFileAttachment[] = [];
  const uploadedPaths: string[] = [];
  for (const att of fileAttachments) {
    try {
      const result = await uploadFileToServer(state.client, att);
      uploadedFiles.push({
        type: "file",
        id: result.id,
        path: result.path,
        fileName: result.fileName,
        size: result.size,
        mimeType: result.mimeType,
      });
      uploadedPaths.push(`[Uploaded: ${result.path}]`);
    } catch (err) {
      console.error("File upload failed:", err);
      // Continue with other attachments
    }
  }

  // If this message only had file attachments and all uploads failed, do not send an empty chat request.
  if (
    !msg &&
    imageAttachments.length === 0 &&
    fileAttachments.length > 0 &&
    uploadedFiles.length === 0
  ) {
    state.lastError = "All file uploads failed";
    return null;
  }

  // Append file paths to message
  if (uploadedPaths.length > 0) {
    const pathsText = uploadedPaths.join("\n");
    msg = msg ? `${msg}\n\n${pathsText}` : pathsText;
  }

  // Build user message content blocks
  const contentBlocks: Array<{ type: string; text?: string; source?: unknown }> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  // Add image previews to the message for display
  for (const att of imageAttachments) {
    contentBlocks.push({
      type: "image",
      source: { type: "base64", media_type: att.mimeType, data: att.dataUrl },
    });
  }

  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: contentBlocks,
      timestamp: now,
    },
  ];

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;

  // Convert image attachments to API format and include uploaded file references.
  const apiImageAttachments =
    imageAttachments.length > 0
      ? imageAttachments
          .map((att) => {
            const parsed = dataUrlToBase64(att.dataUrl);
            if (!parsed) {
              return null;
            }
            return {
              type: "image",
              mimeType: parsed.mimeType,
              content: parsed.content,
            };
          })
          .filter((a): a is NonNullable<typeof a> => a !== null)
      : undefined;
  const apiAttachmentsMerged = [...(apiImageAttachments ?? []), ...uploadedFiles];
  const apiAttachments = apiAttachmentsMerged.length > 0 ? apiAttachmentsMerged : undefined;

  try {
    await state.client.request("chat.send", {
      sessionKey: state.sessionKey,
      message: msg,
      deliver: false,
      idempotencyKey: runId,
      attachments: apiAttachments,
    });
    return runId;
  } catch (err) {
    const error = String(err);
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return null;
  } finally {
    state.chatSending = false;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId ? { sessionKey: state.sessionKey, runId } : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = String(err);
    return false;
  }
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  if (payload.sessionKey !== state.sessionKey) {
    return null;
  }

  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      return "final";
    }
    return null;
  }

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (typeof next === "string") {
      const current = state.chatStream ?? "";
      if (!current || next.length >= current.length) {
        state.chatStream = next;
      }
    }
  } else if (payload.state === "final") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "aborted") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "error") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}
