export type AllowFromMode = "topOnly" | "topOrNested" | "nestedOnly";

export function resolveAllowFromMode(channelName: string): AllowFromMode {
  if (channelName === "googlechat" || channelName === "matrix") {
    return "nestedOnly";
  }
  if (channelName === "discord" || channelName === "slack") {
    return "topOrNested";
  }
  return "topOnly";
}
