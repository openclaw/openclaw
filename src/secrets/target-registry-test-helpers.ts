export function canonicalizeSecretTargetCoverageId(id: string): string {
  if (id === "tools.web.x_search.apiKey") {
    return "plugins.entries.xai.config.webSearch.apiKey";
  }
  if (id === "talk.apiKey") {
    return "talk.providers.elevenlabs.apiKey";
  }
  return id;
}
