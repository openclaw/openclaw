type UsageQueryTerm = {
  key?: string;
  value: string;
  raw: string;
};

export const extractQueryTerms = (query: string): UsageQueryTerm[] => {
  const rawTokens = query.match(/(?:[^\s"]|"[^"]*")+/g) ?? [];
  return rawTokens.map((token) => {
    const cleaned = token.replace(/^"(.*)"$/u, "$1");
    const idx = cleaned.indexOf(":");
    if (idx > 0) {
      const key = cleaned.slice(0, idx);
      const value = cleaned.slice(idx + 1).replace(/^"(.*)"$/u, "$1");
      return { key, value, raw: token };
    }
    return { value: cleaned, raw: token };
  });
};
