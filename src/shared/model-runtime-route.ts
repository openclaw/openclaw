/** Presentation only: a provider name alone does not identify Anthropic's execution route. */
export function resolveModelRuntimeRoute(
  provider: string,
  runtimeId?: string,
): "claudeCli" | "anthropicApi" | "anthropicConfigured" | undefined {
  if (runtimeId === "claude-cli" || (provider === "claude-cli" && !runtimeId)) {
    return "claudeCli";
  }
  if (provider === "anthropic") {
    if (runtimeId === "openclaw") {
      return "anthropicApi";
    }
    if (!runtimeId) {
      return "anthropicConfigured";
    }
  }
  return undefined;
}
