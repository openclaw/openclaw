import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import type { ChatAccountSelection } from "../../../packages/gateway-protocol/src/schema/users.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";

export const chatMetadataSessionFields = [
  "sessionId",
  "lifecycleRevision",
  "sessionStartedAt",
  "acp",
  "agentHarnessId",
  "agentRuntimeOverride",
  "modelSelectionLocked",
  "pluginOwnerId",
  "providerOverride",
  "modelOverride",
  "modelOverrideRouteResolution",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
] as const satisfies readonly (keyof SessionEntry)[];

export type ChatMetadataSessionEntry = Partial<
  Pick<SessionEntry, (typeof chatMetadataSessionFields)[number]>
>;

export type ChatMetadataReadParams = {
  agentId: string;
  sessionKey?: string;
  storePath?: string;
  requesterProfileId?: string;
  sessionEntry?: ChatMetadataSessionEntry;
  /** Saved reads retain their selected row and physical store until response settlement. */
  isCurrent?: () => boolean;
  assertCurrent?: () => void;
  release?: () => void;
  draftAccountSelection?: UserModelAccountSelection;
};

export type ChatMetadataResult = {
  commands?: unknown[];
  models?: ModelChoice[];
  modelSelectionPolicy?: ModelsListResult["modelSelectionPolicy"];
  swarmEnabled: boolean;
  runtimeSelectionLocked?: boolean;
  accountSelection?: ChatAccountSelection;
};
