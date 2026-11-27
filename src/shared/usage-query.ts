type UsageQueryTerm = {
  key?: string;
  value: string;
  raw: string;
};

// Double literal quotes inside quoted values so backslashes keep their handwritten meaning.
export function formatUsageQueryToken(key: string, value: string): string {
  return /[\s"]/u.test(value) ? `${key}:"${value.replaceAll('"', '""')}"` : `${key}:${value}`;
}

export const extractQueryTerms = (query: string): UsageQueryTerm[] => {
  const rawTokens = query.match(/(?:[^\s"]|"[^"]*")+/g) ?? [];
  return rawTokens.map((token) => {
    const cleaned = token.replace(/^"(.*)"$/su, "$1");
    const idx = cleaned.indexOf(":");
    if (idx > 0) {
      const key = cleaned.slice(0, idx);
      const value = cleaned
        .slice(idx + 1)
        .replace(/^"(.*)"$/su, (_, quoted: string) => quoted.replaceAll('""', '"'));
      return { key, value, raw: token };
    }
    return { value: cleaned, raw: token };
  });
};
