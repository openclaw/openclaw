import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { AgentModelPrimaryWriteTarget } from "../../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { ModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "./directives.js";

export type HandleDirectiveOnlyParams = {
  cfg: OpenClawConfig;
  agentId: string;
  directives: InlineDirectives;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures?: Array<{ gate: string; key: string }>;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  modelPolicy?: ModelVisibilityPolicy;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  allowedModelCatalog: Awaited<
    ReturnType<typeof import("../../agents/prepared-model-catalog.js").readPreparedModelCatalog>
  >;
  thinkingCatalog?: ModelCatalogEntry[];
  resetModelOverride: boolean;
  provider: string;
  model: string;
  initialModelLabel: string;
  formatModelSwitchEvent: (label: string, alias?: string) => string;
  canPersistStickyModelSelection?: boolean;
  stickyModelSelectionTarget?: AgentModelPrimaryWriteTarget;
  onRejection?: () => void;
  ctx?: MsgContext;
  messageProvider?: string;
  currentThinkLevel?: ThinkLevel;
  currentFastMode?: FastMode;
  currentVerboseLevel?: VerboseLevel;
  currentReasoningLevel?: ReasoningLevel;
  currentElevatedLevel?: ElevatedLevel;
  workspaceDir?: string;
  surface?: string;
  gatewayClientScopes?: string[];
  commandAuthorized?: boolean;
  senderIsOwner?: boolean;
  /** Mixed messages consume the transaction outcome without repeating persistence. */
  persistenceState?: {
    outcome:
      | {
          kind: "pending" | "applied";
          provider: string;
          model: string;
          modelCatalog?: ModelCatalogEntry[];
        }
      | { kind: "rejected"; errorText: string };
  };
};
