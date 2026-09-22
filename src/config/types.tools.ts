// Defines tool availability and allowlist configuration types.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { z } from "zod";
import type { ChatType } from "../channels/chat-type.js";
import type { SafeBinProfileFixture } from "../infra/exec-safe-bin-policy.js";
import type { AgentElevatedAllowFromConfig, SessionSendPolicyAction } from "./types.base.js";
import type { ConfiguredProviderRequest } from "./types.provider-request.js";
import type {
  AgentEntrySchema,
  ToolsSchema,
  ToolPolicySchema,
} from "./zod-schema.agent-runtime.js";
type SchemaToolsConfig = NonNullable<z.input<typeof ToolsSchema>>;
type SchemaMediaConfig = NonNullable<SchemaToolsConfig["media"]>;
type SchemaAudioConfig = NonNullable<SchemaMediaConfig["audio"]>;

export type { MemorySearchConfig } from "./types.memory.js";

export type MediaUnderstandingScopeMatch = {
  /** Channel/provider id to match before running media or link understanding. */
  channel?: string;
  /** Direct/group classification from the channel runtime, when available. */
  chatType?: ChatType;
  /** Attachment or link key prefix used for narrow per-source routing. */
  keyPrefix?: string;
};

export type MediaUnderstandingScopeRule = {
  /** Policy applied when match criteria select this scope rule. */
  action: SessionSendPolicyAction;
  /** Optional match filter; omitted match behaves as a catch-all rule. */
  match?: MediaUnderstandingScopeMatch;
};

export type MediaUnderstandingScopeConfig = {
  /** Fallback action when no scope rule matches. */
  default?: SessionSendPolicyAction;
  /** Ordered allow/block rules; first matching rule wins. */
  rules?: MediaUnderstandingScopeRule[];
};

export type MediaUnderstandingCapability = "image" | "audio" | "video";

export type MediaUnderstandingAttachmentsConfig = NonNullable<SchemaAudioConfig["attachments"]>;

export type MediaUnderstandingModelConfig = Omit<
  NonNullable<NonNullable<SchemaMediaConfig["models"]>[number]>,
  "request"
> & { request?: ConfiguredProviderRequest };

export type MediaUnderstandingConfig = Omit<SchemaAudioConfig, "scope" | "request"> & {
  scope?: MediaUnderstandingScopeConfig;
  request?: ConfiguredProviderRequest;
  /** Ordered model list (fallbacks in order). */
  models?: MediaUnderstandingModelConfig[];
  /** Internal request-scoped prompt override injected by CLI/runtime wrappers. */
  _requestPromptOverride?: string;
  /** Internal request-scoped language override injected by CLI/runtime wrappers. */
  _requestLanguageOverride?: string;
};

/** Per-capability defaults and policy. Models live only in tools.media.models. */
export type MediaUnderstandingCapabilityConfig = Omit<MediaUnderstandingConfig, "models">;

export type LinkModelConfig = NonNullable<
  NonNullable<NonNullable<SchemaToolsConfig["links"]>["models"]>[number]
>;

export type LinkToolsConfig = Omit<NonNullable<SchemaToolsConfig["links"]>, "scope"> & {
  scope?: MediaUnderstandingScopeConfig;
};

export type MediaToolsConfig = {
  /** Canonical model list for image/audio/video, selected by capability tags. */
  models?: MediaUnderstandingModelConfig[];
  /** Max concurrent media understanding runs. */
  concurrency?: number;
  image?: MediaUnderstandingCapabilityConfig;
  audio?: MediaUnderstandingCapabilityConfig;
  video?: MediaUnderstandingCapabilityConfig;
};

export type ToolProfileId = NonNullable<SchemaToolsConfig["profile"]>;

export type ToolLoopDetectionConfig = NonNullable<SchemaToolsConfig["loopDetection"]>;

export type ToolSearchConfig = NonNullable<SchemaToolsConfig["toolSearch"]>;

export type CodeModeConfig = NonNullable<SchemaToolsConfig["codeMode"]>;

export type SwarmConfig = NonNullable<SchemaToolsConfig["swarm"]>;

export type SessionsToolsVisibility = "self" | "tree" | "agent" | "all";

export type ToolAllowDenyPolicyConfig = NonNullable<z.input<typeof ToolPolicySchema>>;

export type ToolPolicyConfig = ToolAllowDenyPolicyConfig & {
  /** Built-in profile used as the base policy before allow/deny merges. */
  profile?: ToolProfileId;
};

export type GroupToolPolicyConfig = ToolAllowDenyPolicyConfig;

export const TOOLS_BY_SENDER_KEY_TYPES = ["channel", "id", "e164", "username", "name"] as const;
export type ToolsBySenderKeyType = (typeof TOOLS_BY_SENDER_KEY_TYPES)[number];

export function parseToolsBySenderTypedKey(
  rawKey: string,
): { type: ToolsBySenderKeyType; value: string } | undefined {
  const trimmed = rawKey.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  for (const type of TOOLS_BY_SENDER_KEY_TYPES) {
    const prefix = `${type}:`;
    if (!lowered.startsWith(prefix)) {
      continue;
    }
    // Preserve the original value casing after the typed prefix; usernames and
    // display names can be case-sensitive in channel-specific matching code.
    return {
      type,
      value: trimmed.slice(prefix.length),
    };
  }
  return undefined;
}

/**
 * Per-sender overrides.
 *
 * Prefer explicit key prefixes:
 * - channel:<channelId>:<senderId>
 * - id:<senderId>
 * - e164:<phone>
 * - username:<handle>
 * - name:<display-name>
 * - * (wildcard)
 *
 * Legacy unprefixed keys are supported for backward compatibility and are matched as senderId only.
 */
export type GroupToolPolicyBySenderConfig = Record<string, GroupToolPolicyConfig>;

export type ExecToolConfig = Omit<NonNullable<SchemaToolsConfig["exec"]>, "safeBinProfiles"> & {
  /** Preserve readonly authoring fixtures accepted by the safe-bin policy owner. */
  safeBinProfiles?: Record<string, SafeBinProfileFixture>;
};

export type FsToolsConfig = NonNullable<SchemaToolsConfig["fs"]>;

export type SessionsSpawnToolsConfig = NonNullable<SchemaToolsConfig["sessions_spawn"]>;

export type GitHubToolIdentityConfig = NonNullable<SchemaToolsConfig["github"]>;

export type AgentToolsConfig = Omit<
  NonNullable<z.input<typeof AgentEntrySchema>["tools"]>,
  "toolsBySender" | "exec" | "elevated"
> & {
  toolsBySender?: GroupToolPolicyBySenderConfig;
  exec?: ExecToolConfig;
  elevated?: {
    enabled?: boolean;
    allowFrom?: AgentElevatedAllowFromConfig;
  };
};

export type ToolsConfig = Omit<
  SchemaToolsConfig,
  "toolsBySender" | "media" | "web" | "exec" | "elevated" | "links"
> & {
  toolsBySender?: GroupToolPolicyBySenderConfig;
  media?: MediaToolsConfig;
  exec?: ExecToolConfig;
  elevated?: AgentToolsConfig["elevated"];
  links?: LinkToolsConfig;
  web?: {
    search?: {
      /** Enable managed web_search and optional Codex-native web search. */
      enabled?: boolean;
      /** Search provider id. */
      provider?: string;
      /** Default search results count (1-10). */
      maxResults?: number;
      /** Timeout in seconds for search requests. */
      timeoutSeconds?: number;
      /** Cache TTL in minutes for search results. */
      cacheTtlMinutes?: number;
      /** Optional native Codex web search for Codex-capable models. */
      openaiCodex?: {
        /** Enable native Codex web search for eligible models. */
        enabled?: boolean;
        /** Prefer cached or explicitly request live access. Unrestricted Codex turns resolve cached to live. */
        mode?: "cached" | "live";
        /** Native Codex search allowlist; also gates web_fetch on native-hosted-search turns. */
        allowedDomains?: string[];
        /** Optional Codex native search context size hint. */
        contextSize?: "low" | "medium" | "high";
        /** Optional approximate user location passed to the native Codex tool. */
        userLocation?: {
          country?: string;
          region?: string;
          city?: string;
          timezone?: string;
        };
      };
    };
    fetch?: NonNullable<SchemaToolsConfig["web"]>["fetch"];
  };
};

export type MessageToolsConfig = NonNullable<SchemaToolsConfig["message"]>;
