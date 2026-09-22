import { getReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";

const MIN_TRUNCATED_FINAL_PREFIX_CHARS = 48;
const MIN_TRUNCATED_FINAL_CONTINUATION_CHARS = 24;

function stripTrailingEllipsis(text: string): string {
  // Start at a whitespace-run boundary instead of retrying every blank line.
  return text.replace(/(?<!\s)(?:\s*(?:\.{3}|\u2026))+$/u, "").trimEnd();
}

export function isPotentialTruncatedFinal(finalText: string): boolean {
  const trimmedFinal = finalText.trimEnd();
  const untruncatedFinal = stripTrailingEllipsis(trimmedFinal);
  return (
    untruncatedFinal.length >= MIN_TRUNCATED_FINAL_PREFIX_CHARS && untruncatedFinal !== trimmedFinal
  );
}

export function selectLongerFinalText(params: {
  finalText: string;
  candidateTexts: readonly (string | undefined)[];
}): string | undefined {
  const finalText = params.finalText.trimEnd();
  if (!isPotentialTruncatedFinal(finalText)) {
    return undefined;
  }
  const untruncatedFinal = stripTrailingEllipsis(finalText);
  for (const candidate of params.candidateTexts) {
    const candidateText = candidate?.trimEnd();
    if (
      !candidateText ||
      candidateText.length <= finalText.length ||
      !candidateText.startsWith(untruncatedFinal)
    ) {
      continue;
    }
    const continuation = candidateText.slice(untruncatedFinal.length).trimStart();
    if (
      continuation.length >= MIN_TRUNCATED_FINAL_CONTINUATION_CHARS &&
      /^[\p{L}\p{N}]/u.test(continuation)
    ) {
      return candidateText;
    }
  }
  return undefined;
}

export async function resolveTranscriptBackedChannelFinalText(params: {
  // Optional: shipped plugin callers pass only text; an answer to a preceding input keeps its own text.
  payload?: ReplyPayload;
  finalText: string;
  resolveCandidateText: () => Promise<string | undefined>;
}): Promise<string> {
  if (
    (params.payload && getReplyPayloadMetadata(params.payload)?.precedingInputAnswer) ||
    !isPotentialTruncatedFinal(params.finalText)
  ) {
    return params.finalText;
  }
  const candidateText = await params.resolveCandidateText();
  return (
    selectLongerFinalText({
      finalText: params.finalText,
      candidateTexts: [candidateText],
    }) ?? params.finalText
  );
}
