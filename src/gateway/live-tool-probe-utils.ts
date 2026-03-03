export function hasExpectedToolNonce(text: string, nonceA: string, nonceB: string): boolean {
  return text.includes(nonceA) && text.includes(nonceB);
}

export function hasExpectedSingleNonce(text: string, nonce: string): boolean {
  return text.includes(nonce);
}

function hasMalformedToolOutput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  if (trimmed.includes("[object Object]")) {
    return true;
  }
  if (/\bread\s*\[/.test(lower) || /\btool\b/.test(lower) || /\bfunction\b/.test(lower)) {
    return true;
  }
  return false;
}

export function shouldRetryToolReadProbe(params: {
  text: string;
  nonceA: string;
  nonceB: string;
  provider: string;
  attempt: number;
  maxAttempts: number;
}): boolean {
  if (params.attempt + 1 >= params.maxAttempts) {
    return false;
  }
  if (hasExpectedToolNonce(params.text, params.nonceA, params.nonceB)) {
    return false;
  }
  if (hasMalformedToolOutput(params.text)) {
    return true;
  }
  const lower = params.text.trim().toLowerCase();
  if (params.provider === "mistral" && (lower.includes("noncea=") || lower.includes("nonceb="))) {
    return true;
  }
  return false;
}

export function shouldRetryExecReadProbe(params: {
  text: string;
  nonce: string;
  attempt: number;
  maxAttempts: number;
}): boolean {
  if (params.attempt + 1 >= params.maxAttempts) {
    return false;
  }
  if (hasExpectedSingleNonce(params.text, params.nonce)) {
    return false;
  }
  return hasMalformedToolOutput(params.text);
}
