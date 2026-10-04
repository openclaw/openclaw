import type { RespondFn } from "./server-methods/shared-types.js";

type CapturedChatResult = { ok: boolean; payload?: unknown };
export type CapturedChatResponse = CapturedChatResult & { error?: unknown };

export function captureChatResult(results: CapturedChatResult[]): RespondFn {
  return (ok, payload) => {
    results.push({ ok, payload });
  };
}

export function captureChatResponse(responses: CapturedChatResponse[]): RespondFn {
  return (ok, payload, error) => {
    responses.push({ ok, payload, error });
  };
}
