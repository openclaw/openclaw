import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { SessionContextCapacityResolver } from "../agents/session-context-capacity.js";
import type { resolveSelectedAndActiveModel } from "../auto-reply/model-runtime.js";
import type {
  ElevatedLevel,
  ReasoningLevel,
  ThinkLevel,
  ThinkingCatalogEntry,
  VerboseLevel,
} from "../auto-reply/thinking.js";
import type { SessionEntry, SessionScope } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MediaUnderstandingDecision } from "../media-understanding/types.js";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
type AgentConfig = Partial<AgentDefaults> & {
  model?: AgentDefaults["model"] | string;
};

export type QueueStatus = {
  mode?: string;
  depth?: number;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: string;
  showDetails?: boolean;
};

export type StatusArgs = {
  config: OpenClawConfig;
  modelRefs: ReturnType<typeof resolveSelectedAndActiveModel>;
  agent: AgentConfig;
  agentId?: string;
  configuredDefaultModelLabel?: string;
  selectedContextWindow?: number;
  selectedContextTokens?: number;
  thinkingCatalog?: ThinkingCatalogEntry[];
  runtimeContextProvider?: string;
  runtimeContextTokens?: number;
  sessionEntry?: SessionEntry;
  /** Admitted-owner capacity for the displayed session; see session-context-capacity. */
  resolveOwnerContextCapacity?: SessionContextCapacityResolver;
  sessionKey?: string;
  parentSessionKey?: string;
  sessionScope?: SessionScope;
  sessionStorePath?: string;
  sessionStartedAt?: number;
  groupActivation?: "mention" | "always";
  resolvedThink?: ThinkLevel;
  resolvedFast?: FastMode;
  resolvedHarness?: string;
  resolvedVerbose?: VerboseLevel;
  resolvedReasoning?: ReasoningLevel;
  resolvedElevated?: ElevatedLevel;
  modelAuth?: string;
  selectedEndpoint?: string;
  activeModelAuth?: string;
  activeModel?: { modelProvider: string; model: string };
  usageLine?: string;
  timeLine?: string;
  uptimeValue?: string;
  queue?: QueueStatus;
  mediaDecisions?: ReadonlyArray<MediaUnderstandingDecision>;
  subagentsLine?: string;
  pluginHealthLine?: string;
  channelFeatureLine?: string;
  includeTranscriptUsage?: boolean;
  now?: number;
};
