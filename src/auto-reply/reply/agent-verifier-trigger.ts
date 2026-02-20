const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(string: string): string {
  return string.replace(REGEX_SPECIAL_CHARS, "\\$&");
}

function isSimpleWord(keyword: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(keyword);
}

export function shouldVerifyResponse(text: string, keywords: string[]): boolean {
  if (!text || keywords.length === 0) {
    return false;
  }

  return keywords.some((keyword) => {
    const escaped = escapeRegExp(keyword);

    const pattern = keyword.includes(" ") || !isSimpleWord(keyword) ? escaped : `\\b${escaped}\\b`;

    return new RegExp(pattern, "i").test(text);
  });
}
