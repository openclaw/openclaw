import { makeProxyFetch } from "../telegram/proxy.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";

const MAX_API_BASE = "https://platform-api.max.ru";

/** Options for sending a MAX message. */
export type MaxSendOpts = {
  token?: string;
  accountId?: string;
  verbose?: boolean;
  mediaUrl?: string;
  format?: "markdown" | "html";
  replyToMessageId?: string;
  buttons?: Array<Array<{ text: string; payload: string }>>;
  proxy?: string;
  notify?: boolean;
  disableLinkPreview?: boolean;
};

/** Result of sending a MAX message. */
export type MaxSendResult = {
  messageId: string;
  chatId: string;
};

/**
 * Sends a text message via the MAX Bot API.
 *
 * POST /messages?chat_id=<chatId>
 * Body: { text, format?, link?, notify?, disable_link_preview? }
 */
export async function sendMessageMax(
  chatId: string,
  text: string,
  opts: MaxSendOpts = {},
): Promise<MaxSendResult> {
  const token = opts.token ?? "";
  const fetcher = opts.proxy ? makeProxyFetch(opts.proxy) : fetch;
  const headers: Record<string, string> = {
    Authorization: token,
    "Content-Type": "application/json",
  };

  // Build request body
  const body: Record<string, unknown> = {
    text,
  };

  if (opts.format) {
    body.format = opts.format;
  }

  if (opts.notify === false) {
    body.notify = false;
  }

  if (opts.disableLinkPreview) {
    body.disable_link_preview = true;
  }

  // Reply link
  if (opts.replyToMessageId) {
    body.link = {
      type: "reply",
      mid: opts.replyToMessageId,
    };
  }

  // Inline keyboard
  if (opts.buttons?.length) {
    body.attachments = [
      {
        type: "inline_keyboard",
        payload: {
          buttons: opts.buttons.map((row) =>
            row.map((btn) => ({
              type: "callback",
              text: btn.text,
              payload: btn.payload,
            })),
          ),
        },
      },
    ];
  }

  const url = `${MAX_API_BASE}/messages?chat_id=${encodeURIComponent(chatId)}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    30_000,
    fetcher,
  );

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`MAX sendMessage failed (${res.status}): ${errorBody}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  const message = json.message as Record<string, unknown> | undefined;

  return {
    messageId:
      typeof message?.mid === "string" ? message.mid : String(message?.mid ?? json.mid ?? ""),
    chatId: String(chatId),
  };
}

/**
 * Sends a media message via the MAX Bot API (two-step upload).
 *
 * Step 1: POST /uploads?type=<mediaType>
 * Step 2: POST /messages?chat_id=<chatId> with attachment
 */
export async function sendMediaMax(
  chatId: string,
  mediaBuffer: Buffer,
  opts: MaxSendOpts & {
    mediaType?: "photo" | "video" | "audio" | "file";
    fileName?: string;
    caption?: string;
    mimeType?: string;
  } = {},
): Promise<MaxSendResult> {
  const token = opts.token ?? "";
  const fetcher = opts.proxy ? makeProxyFetch(opts.proxy) : fetch;
  const headers: Record<string, string> = { Authorization: token };

  const mediaType = opts.mediaType ?? "file";

  // Step 1: Upload
  const uploadUrl = `${MAX_API_BASE}/uploads?type=${mediaType}`;
  const formData = new FormData();
  const blob = new Blob([mediaBuffer], { type: opts.mimeType ?? "application/octet-stream" });
  formData.append("data", blob, opts.fileName ?? "file");

  const uploadRes = await fetchWithTimeout(
    uploadUrl,
    {
      method: "POST",
      headers,
      body: formData,
    },
    60_000,
    fetcher,
  );

  if (!uploadRes.ok) {
    const errorBody = await uploadRes.text().catch(() => "");
    throw new Error(`MAX upload failed (${uploadRes.status}): ${errorBody}`);
  }

  const uploadJson = (await uploadRes.json()) as Record<string, unknown>;

  // Step 2: Send message with attachment
  const body: Record<string, unknown> = {
    text: opts.caption ?? "",
    attachments: [uploadJson],
  };

  if (opts.format) {
    body.format = opts.format;
  }

  if (opts.replyToMessageId) {
    body.link = { type: "reply", mid: opts.replyToMessageId };
  }

  const msgUrl = `${MAX_API_BASE}/messages?chat_id=${encodeURIComponent(chatId)}`;
  const msgRes = await fetchWithTimeout(
    msgUrl,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    30_000,
    fetcher,
  );

  if (!msgRes.ok) {
    const errorBody = await msgRes.text().catch(() => "");
    throw new Error(`MAX sendMedia failed (${msgRes.status}): ${errorBody}`);
  }

  const msgJson = (await msgRes.json()) as Record<string, unknown>;
  const message = msgJson.message as Record<string, unknown> | undefined;

  return {
    messageId:
      typeof message?.mid === "string" ? message.mid : String(message?.mid ?? msgJson.mid ?? ""),
    chatId: String(chatId),
  };
}
