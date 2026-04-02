export function canonicalizeSecretTargetCoverageId(id: string): string {
  return id === "tools.web.x_search.apiKey" ? "plugins.entries.xai.config.webSearch.apiKey" : id;
}
