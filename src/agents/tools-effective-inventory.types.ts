/**
 * Effective tool inventory contract types.
 * Shared by agent/session tool inventory resolvers and UI/API callers that
 * present enabled tools grouped by source.
 */
import type { ToolsEffectiveEntry } from "../../packages/gateway-protocol/src/schema/tools-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";

export type {
  ToolsEffectiveEntry as EffectiveToolInventoryEntry,
  ToolsEffectiveGroup as EffectiveToolInventoryGroup,
  ToolsEffectiveNotice as EffectiveToolInventoryNotice,
  ToolsEffectiveResult as EffectiveToolInventoryResult,
} from "../../packages/gateway-protocol/src/schema/tools-catalog.js";

export type EffectiveToolSource = ToolsEffectiveEntry["source"];

/** Inputs for resolving the effective tool inventory in a session/runtime context. */
export type ResolveEffectiveToolInventoryParams = {
  cfg: OpenClawConfig;
  conversationCapabilityProfile?: ResolvedConversationCapabilityProfile;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  agentDir?: string;
  messageProvider?: string;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  accountId?: string | null;
  modelProvider?: string;
  modelId?: string;
  modelApi?: string | null;
  runtimeModel?: ProviderRuntimeModel;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  replyToMode?: "off" | "first" | "all" | "batched";
  modelHasVision?: boolean;
  requireExplicitMessageTarget?: boolean;
  disableMessageTool?: boolean;
};
