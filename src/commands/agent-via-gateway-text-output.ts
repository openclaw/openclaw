import type { RuntimeEnv } from "../runtime.js";

type ReplyPayloadLike = {
  text?: string;
  mediaUrl?: string | null;
  mediaUrls?: string[];
};

/** Logs the text (non-`--json`) reply rendering for one settled agent response. */
export async function logAgentReplyTextOutput(params: {
  status?: string;
  summary?: string;
  payloads: ReplyPayloadLike[];
  runtime: RuntimeEnv;
}): Promise<void> {
  const { status, summary, payloads, runtime } = params;
  for (const payload of payloads) {
    const { resolveSendableOutboundReplyParts } = await import("openclaw/plugin-sdk/reply-payload");
    const { formatOutboundPayloadLog } = await import("../infra/outbound/payloads.js");
    const parts = resolveSendableOutboundReplyParts({
      text: payload.text,
      mediaUrls: payload.mediaUrls,
      mediaUrl: typeof payload.mediaUrl === "string" ? payload.mediaUrl : undefined,
    });
    const out = formatOutboundPayloadLog(parts).trimEnd();
    if (out) {
      runtime.log(out);
    }
  }

  // A failed run's explanation (e.g. a provider usage limit and its reset
  // time) lives in the response summary, while the payloads may only carry an
  // earlier tool warning. Print the summary too unless a payload already shows
  // it; success statuses ("ok", "completed" per markAgentRunExitCode) never print.
  if (
    status !== "ok" &&
    status !== "completed" &&
    summary &&
    !payloads.some((payload) => payload.text?.trim() === summary.trim())
  ) {
    runtime.log(summary);
  }
}
