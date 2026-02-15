import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { MsgContext } from "../templating.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "./directives.js";

export type HandleDirectiveOnlyCoreParams = {
  cfg: OpenClawConfig;
  directives: InlineDirectives;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures?: Array<{ gate: string; key: string }>;
  messageProviderKey?: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: Awaited<
    ReturnType<typeof import("../../agents/model-catalog.js").loadModelCatalog>
  >;
  resetModelOverride: boolean;
  provider: string;
  model: string;
  initialModelLabel: string;
  formatModelSwitchEvent: (label: string, alias?: string) => string;
};

export type HandleDirectiveOnlyParams = HandleDirectiveOnlyCoreParams & {
  currentThinkLevel?: ThinkLevel;
  currentVerboseLevel?: VerboseLevel;
  currentReasoningLevel?: ReasoningLevel;
  currentElevatedLevel?: ElevatedLevel;
  surface?: string;
};

export type ApplyInlineDirectivesFastLaneParams = HandleDirectiveOnlyCoreParams & {
  commandAuthorized: boolean;
  ctx: MsgContext;
  agentId?: string;
  isGroup: boolean;
  agentCfg?: NonNullable<OpenClawConfig["agents"]>["defaults"];
  modelState: {
    resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
    allowedModelKeys: Set<string>;
    allowedModelCatalog: Awaited<
      ReturnType<typeof import("../../agents/model-catalog.js").loadModelCatalog>
    >;
    resetModelOverride: boolean;
  };
};
