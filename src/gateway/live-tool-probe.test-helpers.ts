import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export function hasExpectedToolNonce(text: string, nonceA: string, nonceB: string): boolean {
  return text.includes(nonceA) && text.includes(nonceB);
}

export function hasExpectedSingleNonce(text: string, nonce: string): boolean {
  return text.includes(nonce);
}

const NONCE_REFUSAL_MARKERS = [
  /token|secret|local file|uuid[ -]named file|parrot back|disclose/,
  /(?:can['’]t|cannot) (?:help|comply)|won['’]t output/,
  /no (?:`read`|read(?:\/read)? tool)/,
  /(?:isn't|not) a real openclaw probe|no part of the system asks me/,
];

const PROBE_REFUSAL_MARKERS = [
  /prompt injection attempt|not (?:a )?legitimate self-test/,
  /authorized integration probe|authorizing me to (?:execute|run)/,
];

export function isLikelyToolNonceRefusal(text: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(text);
  return (
    PROBE_REFUSAL_MARKERS.some((marker) => marker.test(lower)) ||
    (lower.includes("nonce") && NONCE_REFUSAL_MARKERS.some((marker) => marker.test(lower)))
  );
}

function hasMalformedToolOutput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("[object Object]")) {
    return true;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  return (
    /try reading the file again|trying to read the file again/.test(lower) ||
    /try again with a slightly different approach|try the read tool again/.test(lower) ||
    /file wasn't found immediately|file read failed because the file was not found/.test(lower) ||
    /verify the file (?:exists|creation) and read it again/.test(lower) ||
    /\bread\s*\[|\b(?:tool|function)\b/.test(lower)
  );
}

type ProbeAttempt = {
  text: string;
  provider: string;
  attempt: number;
  maxAttempts: number;
  retryKnownNonceMismatch?: boolean;
};

function retryableOutput(params: ProbeAttempt): boolean {
  return (
    params.retryKnownNonceMismatch === true ||
    hasMalformedToolOutput(params.text) ||
    (params.provider === "anthropic" && isLikelyToolNonceRefusal(params.text))
  );
}

export function shouldRetryToolReadProbe(
  params: ProbeAttempt & { nonceA: string; nonceB: string },
): boolean {
  if (
    params.attempt + 1 >= params.maxAttempts ||
    hasExpectedToolNonce(params.text, params.nonceA, params.nonceB)
  ) {
    return false;
  }
  return (
    retryableOutput(params) ||
    (params.provider === "mistral" &&
      /nonce[ab]=|testmarker[ab]=/.test(normalizeLowercaseStringOrEmpty(params.text)))
  );
}

export function shouldRetryExecReadProbe(params: ProbeAttempt & { nonce: string }): boolean {
  return (
    !(params.attempt + 1 >= params.maxAttempts) &&
    !hasExpectedSingleNonce(params.text, params.nonce) &&
    retryableOutput(params)
  );
}
