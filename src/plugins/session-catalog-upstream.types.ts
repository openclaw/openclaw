export type SessionUpstreamJsonValue =
  | null
  | boolean
  | number
  | string
  | SessionUpstreamJsonValue[]
  | { [key: string]: SessionUpstreamJsonValue };

export type SessionUpstreamKind = "claude-cli" | "codex-app-server" | "opencode-cli" | "pi-cli";
