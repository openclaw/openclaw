/** Prepares and authorizes the concrete model effect for reply directives. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ModelSelectionLockedError } from "../../sessions/model-overrides.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { resolveCommandAuthorizationDenialText } from "./commands-authorization.js";
import type { CommandContext } from "./commands-types.js";
import {
  type PreparedModelDirectiveEffect,
  prepareModelDirectiveEffect,
} from "./directive-handling.model-selection.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { authorizeResolvedReplyModelDirective } from "./get-reply-directives-authorization.js";
import { canUseFastExplicitModelDirective } from "./get-reply-directives-input.js";
import {
  createFastTestModelSelectionState,
  createModelSelectionState,
  resolveContextTokens,
} from "./model-selection.js";

type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];
export type ReplyDirectiveModelState = Awaited<ReturnType<typeof createModelSelectionState>>;

export type PreparedReplyDirectiveModel = {
  kind: "continue";
  modelState: ReplyDirectiveModelState;
  provider: string;
  model: string;
  contextTokens: number;
  effectiveModelDirective?: string;
  modelDirectiveEffect: PreparedModelDirectiveEffect;
};

type ReplyDirectiveModelPreparation =
  | { kind: "reply"; reply: ReplyPayload }
  | PreparedReplyDirectiveModel;

/** Resolves model state, prepares its exact mutation, then authorizes that same effect. */
export async function prepareReplyDirectiveModel(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  runtimePolicySessionKey?: string;
  storePath?: string;
  defaultProvider: string;
  defaultModel: string;
  primaryProvider?: string;
  primaryModel?: string;
  aliasIndex: ModelAliasIndex;
  provider: string;
  model: string;
  directives: InlineDirectives;
  allowTextCommands: boolean;
  command: CommandContext;
  useFastReplyRuntime: boolean;
  hasOneTurnModelOverride?: boolean;
  skipStoredModelOverride?: boolean;
  hasResolvedHeartbeatModelOverride: boolean;
  isHeartbeat: boolean;
  signal?: AbortSignal;
}): Promise<ReplyDirectiveModelPreparation> {
  const useFastModelSelection =
    params.useFastReplyRuntime &&
    !params.hasResolvedHeartbeatModelOverride &&
    !(params.agentCfg?.models && Object.keys(params.agentCfg.models).length > 0) &&
    !normalizeOptionalString(params.sessionEntry.modelOverride) &&
    !normalizeOptionalString(params.sessionEntry.providerOverride) &&
    (!params.directives.hasModelDirective ||
      canUseFastExplicitModelDirective({
        directives: params.directives,
        defaultProvider: params.defaultProvider,
        aliasIndex: params.aliasIndex,
      }));

  let modelState: ReplyDirectiveModelState;
  try {
    modelState = useFastModelSelection
      ? createFastTestModelSelectionState({
          agentCfg: params.agentCfg,
          provider: params.provider,
          model: params.model,
        })
      : await createModelSelectionState({
          cfg: params.cfg,
          agentId: params.agentId,
          agentCfg: params.agentCfg,
          sessionEntry: params.sessionEntry,
          sessionStore: params.sessionStore,
          sessionKey: params.sessionKey,
          parentSessionKey:
            params.sessionEntry.parentSessionKey ??
            params.ctx.ModelParentSessionKey ??
            params.ctx.ParentSessionKey,
          storePath: params.storePath,
          defaultProvider: params.defaultProvider,
          defaultModel: params.defaultModel,
          primaryProvider: params.primaryProvider,
          primaryModel: params.primaryModel,
          provider: params.provider,
          model: params.model,
          hasModelDirective: params.directives.hasModelDirective,
          hasOneTurnModelOverride: params.hasOneTurnModelOverride,
          skipStoredModelOverride: params.skipStoredModelOverride,
          hasResolvedHeartbeatModelOverride: params.hasResolvedHeartbeatModelOverride,
          isHeartbeat: params.isHeartbeat,
        });
  } catch (error) {
    if (error instanceof ModelSelectionLockedError || isSessionWorkStartInvalidatedError(error)) {
      return { kind: "reply", reply: { text: error.message } };
    }
    throw error;
  }

  const provider = modelState.provider;
  const model = modelState.model;
  const contextTokens = params.useFastReplyRuntime
    ? (params.agentCfg?.contextTokens ?? DEFAULT_CONTEXT_TOKENS)
    : resolveContextTokens({
        cfg: params.cfg,
        agentCfg: params.agentCfg,
        provider,
        model,
        modelContextWindow: modelState.modelContextWindow,
        modelContextTokens: modelState.modelContextTokens,
      });
  const isModelListAlias =
    params.directives.hasModelDirective &&
    ["status", "list"].includes(
      normalizeLowercaseStringOrEmpty(normalizeOptionalString(params.directives.rawModelDirective)),
    );
  const effectiveModelDirective = isModelListAlias
    ? undefined
    : params.directives.rawModelDirective;
  const modelDirectiveEffect = prepareModelDirectiveEffect({
    directives: params.directives,
    effectiveModelDirective,
    cfg: params.cfg,
    agentDir: params.agentDir,
    agentId: params.agentId,
    sessionKey: params.runtimePolicySessionKey,
    sessionEntry: params.sessionEntry,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    aliasIndex: params.aliasIndex,
    allowedModelKeys: modelState.allowedModelKeys,
    allowedModelCatalog: modelState.allowedModelCatalog,
    provider,
  });
  const denial = await authorizeResolvedReplyModelDirective({
    command: params.command,
    ctx: params.ctx,
    directives: params.directives,
    modelEffect: modelDirectiveEffect,
    config: params.cfg,
    allowTextCommands: params.allowTextCommands,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionEntry.sessionId,
    signal: params.signal,
  });
  if (denial) {
    return {
      kind: "reply",
      reply: markReplyPayloadForSourceSuppressionDelivery({
        text: resolveCommandAuthorizationDenialText(denial),
      }),
    };
  }

  return {
    kind: "continue",
    modelState,
    provider,
    model,
    contextTokens,
    effectiveModelDirective,
    modelDirectiveEffect,
  };
}
