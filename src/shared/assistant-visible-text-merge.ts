const ASCII_WORD_RE = /[A-Za-z0-9]/;
const ASCII_PUNCTUATION_RE = /[,:;.!?]/;

function resolveVisibleTextSeparator(base: string, suffix: string): string {
  const lastChar = base.slice(-1);
  const firstChar = suffix[0] ?? "";
  if (!lastChar || !firstChar) {
    return "";
  }
  if (/\s/.test(lastChar) || /\s/.test(firstChar)) {
    return "";
  }
  if (/[,.;:!?)]/.test(firstChar)) {
    return "";
  }
  if (/[([{"'`]/.test(lastChar)) {
    return "";
  }
  if (ASCII_WORD_RE.test(lastChar) && ASCII_WORD_RE.test(firstChar)) {
    return " ";
  }
  if (ASCII_PUNCTUATION_RE.test(lastChar) && ASCII_WORD_RE.test(firstChar)) {
    return " ";
  }
  return "";
}

export function appendUniqueVisibleTextSuffix(base: string, suffix: string): string {
  if (!suffix) {
    return base;
  }
  if (!base) {
    return suffix;
  }
  if (base.endsWith(suffix)) {
    return base;
  }
  const maxOverlap = Math.min(base.length, suffix.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (base.slice(-overlap) === suffix.slice(0, overlap)) {
      return base + suffix.slice(overlap);
    }
  }
  return `${base}${resolveVisibleTextSeparator(base, suffix)}${suffix}`;
}

export function mergeAssistantVisibleText(previousText: string, nextText: string): string {
  if (!previousText) {
    return nextText;
  }
  if (!nextText) {
    return previousText;
  }
  if (nextText.startsWith(previousText)) {
    return nextText;
  }
  if (previousText.startsWith(nextText)) {
    return previousText;
  }
  return appendUniqueVisibleTextSuffix(previousText, nextText);
}
