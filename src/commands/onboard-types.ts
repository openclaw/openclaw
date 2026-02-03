import type { ChannelId } from "../channels/plugins/types.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export type OnboardMode = "local" | "remote";
export type AuthChoice =
  // Legacy alias for `setup-token` (kept for backwards CLI compatibility).
  | "oauth"
  | "setup-token"
  | "claude-cli"
  | "token"
  | "chutes"
  | "vllm"
  | "openai-codex"
  | "openai-api-key"
  | "openrouter-api-key"
  | "litellm-api-key"
  | "ai-gateway-api-key"
  | "cloudflare-ai-gateway-api-key"
  | "moonshot-api-key"
  | "moonshot-api-key-cn"
  | "kimi-code-api-key"
  | "synthetic-api-key"
  | "venice-api-key"
  | "together-api-key"
  | "huggingface-api-key"
  | "codex-cli"
  | "apiKey"
  | "gemini-api-key"
  | "google-antigravity"
  | "google-gemini-cli"
  | "zai-api-key"
  | "zai-coding-global"
  | "zai-coding-cn"
  | "zai-global"
  | "zai-cn"
  | "xiaomi-api-key"
  | "minimax-cloud"
  | "minimax"
  | "minimax-api"
  | "minimax-api-key-cn"
  | "minimax-api-lightning"
  | "minimax-portal"
  | "opencode-zen"
  | "github-copilot"
  | "copilot-proxy"
  | "qwen-portal"
  | "xai-api-key"
  | "volcengine-api-key"
  | "byteplus-api-key"
  | "qianfan-api-key"
  | "custom-api-key"
  | "skip";
export type AuthChoiceGroupId =
  | "openai"
  | "anthropic"
  | "chutes"
  | "vllm"
  | "google"
  | "copilot"
  | "openrouter"
  | "litellm"
  | "ai-gateway"
  | "cloudflare-ai-gateway"
  | "moonshot"
  | "zai"
  | "xiaomi"
  | "opencode-zen"
  | "minimax"
  | "synthetic"
  | "venice"
  | "qwen"
  | "together"
  | "huggingface"
  | "qianfan"
  | "xai"
  | "volcengine"
  | "byteplus"
  | "custom";
export type GatewayAuthChoice = "token" | "password";
export type ResetScope = "config" | "config+creds+sessions" | "full";
export type GatewayBind = "loopback" | "lan" | "auto" | "custom" | "tailnet";
export type TailscaleMode = "off" | "serve" | "funnel";
export type NodeManagerChoice = "npm" | "pnpm" | "bun";
export type ChannelChoice = ChannelId;
// Legacy alias (pre-rename).
export type ProviderChoice = ChannelChoice;

export type OnboardOptions = {
  mode?: OnboardMode;
  /** "manual" is an alias for "advanced". */
  flow?: "quickstart" | "advanced" | "manual";
  workspace?: string;
  nonInteractive?: boolean;
  /** Required for non-interactive onboarding; skips the interactive risk prompt when true. */
  acceptRisk?: boolean;
  reset?: boolean;
  authChoice?: AuthChoice;
  /** Used when `authChoice=token` in non-interactive mode. */
  tokenProvider?: string;
  /** Used when `authChoice=token` in non-interactive mode. */
  token?: string;
  /** Used when `authChoice=token` in non-interactive mode. */
  tokenProfileId?: string;
  /** Used when `authChoice=token` in non-interactive mode. */
  tokenExpiresIn?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  litellmApiKey?: string;
  aiGatewayApiKey?: string;
  cloudflareAiGatewayAccountId?: string;
  cloudflareAiGatewayGatewayId?: string;
  cloudflareAiGatewayApiKey?: string;
  moonshotApiKey?: string;
  kimiCodeApiKey?: string;
  geminiApiKey?: string;
  zaiApiKey?: string;
  xiaomiApiKey?: string;
  minimaxApiKey?: string;
  syntheticApiKey?: string;
  veniceApiKey?: string;
  togetherApiKey?: string;
  huggingfaceApiKey?: string;
  opencodeZenApiKey?: string;
  xaiApiKey?: string;
  volcengineApiKey?: string;
  byteplusApiKey?: string;
  qianfanApiKey?: string;
  customBaseUrl?: string;
  customApiKey?: string;
  customModelId?: string;
  customProviderId?: string;
  customCompatibility?: "openai" | "anthropic";
  gatewayPort?: number;
  gatewayBind?: GatewayBind;
  gatewayAuth?: GatewayAuthChoice;
  gatewayToken?: string;
  gatewayPassword?: string;
  tailscale?: TailscaleMode;
  tailscaleResetOnExit?: boolean;
  installDaemon?: boolean;
  daemonRuntime?: GatewayDaemonRuntime;
  skipChannels?: boolean;
  /** @deprecated Legacy alias for `skipChannels`. */
  skipProviders?: boolean;
  skipSkills?: boolean;
  skipHealth?: boolean;
  skipUi?: boolean;
  nodeManager?: NodeManagerChoice;
  remoteUrl?: string;
  remoteToken?: string;
  json?: boolean;
};
