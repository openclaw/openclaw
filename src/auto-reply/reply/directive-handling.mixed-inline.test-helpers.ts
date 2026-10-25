import { vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { applyInlineDirectiveOverrides } from "./get-reply-directives-apply.js";
import { createMockTypingController } from "./reply.test-helpers.js";

export function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return { sessionId: "session-1", updatedAt: 1, ...overrides };
}

type DirectiveParams = Parameters<typeof applyInlineDirectiveOverrides>[0];
type ModelState = DirectiveParams["modelState"];

type MixedDirectiveParams = {
  body: string;
  abortSignal?: DirectiveParams["abortSignal"];
  resolveThinkingCatalog?: ModelState["resolveThinkingCatalog"];
  cfg?: OpenClawConfig;
  ctx?: DirectiveParams["ctx"];
  agentDir?: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  channel?: string;
  provider?: string;
  model?: string;
  defaultProvider?: string;
  defaultModel?: string;
  allowedModels?: ModelCatalogEntry[];
  modelAliases?: string[];
  aliasIndex?: DirectiveParams["aliasIndex"];
  senderIsOwner?: boolean;
  gatewayClientScopes?: string[];
  operatorAuthority?: ModelState["operatorAuthority"];
  directives?: DirectiveParams["directives"];
  resolveDefaultThinkingLevel?: ModelState["resolveDefaultThinkingLevel"];
};

export function createInlineDirectiveParams(params: MixedDirectiveParams) {
  const cfg: OpenClawConfig = params.cfg ?? { commands: { text: true }, agents: { defaults: {} } };
  const provider = params.provider ?? "anthropic";
  const model = params.model ?? "claude-opus-4-6";
  const channel = params.channel ?? "telegram";
  const sessionKey = params.sessionKey ?? "agent:main:dm:1";
  const sessionEntry = params.sessionEntry ?? createSessionEntry();
  const sessionStore = { [sessionKey]: sessionEntry };
  const directives =
    params.directives ??
    parseInlineSessionDirectives(params.body, { modelAliases: params.modelAliases });
  const allowedModels = params.allowedModels ?? [];
  const modelState: ModelState = {
    provider,
    model,
    requestedRouteResolution: "resolved",
    modelPolicy: createModelVisibilityPolicy({
      cfg,
      catalog: allowedModels,
      defaultProvider: params.defaultProvider ?? provider,
      defaultModel: params.defaultModel ?? model,
      agentId: "main",
    }),
    operatorAuthority: params.operatorAuthority,
    allowedModelKeys: new Set(allowedModels.map((entry) => `${entry.provider}/${entry.id}`)),
    allowedModelCatalog: allowedModels,
    resetModelOverride: false,
    resolveThinkingCatalog: params.resolveThinkingCatalog ?? (async () => allowedModels),
    resolveDefaultThinkingLevel: params.resolveDefaultThinkingLevel ?? (async () => "off"),
    resolveDefaultReasoningLevel: async () => "off",
  };
  const typing = { ...createMockTypingController(), cleanup: vi.fn() };

  return {
    abortSignal: params.abortSignal,
    ctx: {
      ...params.ctx,
      Body: params.body,
      Provider: channel,
      Surface: channel,
      ...(params.gatewayClientScopes ? { GatewayClientScopes: params.gatewayClientScopes } : {}),
    },
    cfg,
    agentId: "main",
    agentDir: params.agentDir ?? "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    agentCfg: cfg.agents?.defaults ?? {},
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath: params.storePath,
    sessionScope: undefined,
    isGroup: false,
    allowTextCommands: true,
    command: {
      surface: channel,
      channel,
      ownerList: [],
      senderIsOwner: params.senderIsOwner ?? false,
      isAuthorizedSender: true,
      rawBodyNormalized: params.body,
      commandBodyNormalized: params.body,
    },
    directives,
    elevatedEnabled: true,
    elevatedAllowed: true,
    elevatedFailures: [],
    defaultProvider: params.defaultProvider ?? provider,
    defaultModel: params.defaultModel ?? model,
    aliasIndex: params.aliasIndex ?? { byAlias: new Map(), byKey: new Map() },
    provider,
    model,
    modelState,
    initialModelLabel: `${provider}/${model}`,
    formatModelSwitchEvent: (label) => `Model switched to ${label}.`,
    resolvedElevatedLevel: "off",
    defaultActivation: () => "always",
    contextTokens: 8192,
    effectiveModelDirective: directives.rawModelDirective,
    typing,
  } satisfies DirectiveParams;
}

export async function applyMixedDirectives(params: MixedDirectiveParams) {
  const input = createInlineDirectiveParams(params);
  const result = await applyInlineDirectiveOverrides(input);
  return {
    result,
    sessionEntry: input.sessionEntry,
    sessionStore: input.sessionStore,
    typing: input.typing,
  };
}
