/**
 * Thin wrapper around the Telegram Bot API 9.5 `sendMessageDraft` method.
 *
 * `sendMessageDraft` is not yet part of the grammy type definitions, so we
 * call it via the raw API client. Once grammy ships types for it we can swap
 * to the typed call with no behaviour change.
 *
 * Spec: https://core.telegram.org/bots/api#sendmessagedraft
 */
import type { Bot } from "grammy";

export type SendMessageDraftParams = {
  chat_id: number | string;
  draft_id: number;
  text: string;
  parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
  message_thread_id?: number;
};

export type SendMessageDraftResult = {
  ok: boolean;
  /** Present on error responses. */
  description?: string;
};

/**
 * Call `sendMessageDraft` via the raw Telegram HTTP API.
 *
 * Telegram animates incremental updates to the same `draft_id` as a typing
 * stream in the client. Finalize by calling `sendMessage` / `editMessageText`
 * with the same content once the LLM response is complete.
 *
 * Returns `true` on success, `false` on a non-fatal API error (e.g. message
 * rate-limited or chat not found). Throws on network-level failures so the
 * caller can apply retry logic.
 */
export async function sendMessageDraft(
  api: Bot["api"],
  params: SendMessageDraftParams,
): Promise<boolean> {
  try {
    // grammy exposes `api.raw` for methods not yet in its type definitions.
    const result = await (
      api as unknown as {
        raw: (method: string, payload: Record<string, unknown>) => Promise<SendMessageDraftResult>;
      }
    ).raw("sendMessageDraft", params as unknown as Record<string, unknown>);
    return result.ok;
  } catch (err) {
    // Re-throw so the caller (draft-stream) can decide whether to stop or retry.
    throw err;
  }
}
