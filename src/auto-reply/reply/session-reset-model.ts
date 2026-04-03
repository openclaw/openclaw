import { resolveAgentDir } from "../../agents/agent-scope.js";
import { loadModelCatalog, type ModelCatalogEntry } from "../../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  modelKey,
  normalizeProviderId,
  resolveModelRefFromString,
  type ModelAliasIndex,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import {
  resolveModelAuthProfile,
  validateModelAuthProfileCompatibility,
} from "./directive-handling.auth-profile.js";
import { resolveModelDirectiveSelection, type ModelDirectiveSelection } from "./model-selection.js";

type ResetModelResult = {
  selection?: ModelDirectiveSelection;
  cleanedBody?: string;
  errorText?: string;
};

function splitBody(body: string) {
  const tokens = body.split(/\s+/).filter(Boolean);
  return {
    tokens,
    first: tokens[0],
    second: tokens[1],
    rest: tokens.slice(2),
  };
}

function buildSelectionFromExplicit(params: {
  raw: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
}): ModelDirectiveSelection | undefined {
  const resolved = resolveModelRefFromString({
    raw: params.raw,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
  });
  if (!resolved) {
    return undefined;
  }
  const key = modelKey(resolved.ref.provider, resolved.ref.model);
  if (params.allowedModelKeys.size > 0 && !params.allowedModelKeys.has(key)) {
    return undefined;
  }
  const isDefault =
    resolved.ref.provider === params.defaultProvider && resolved.ref.model === params.defaultModel;
  return {
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    isDefault,
    ...(resolved.alias ? { alias: resolved.alias } : undefined),
  };
}

function applySelectionToSession(params: {
  selection: ModelDirectiveSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}) {
  const {
    selection,
    profileOverride,
    profileOverrideSource,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
  } = params;
  if (!sessionEntry || !sessionStore || !sessionKey) {
    return;
  }
  const { updated } = applyModelOverrideToSessionEntry({
    entry: sessionEntry,
    selection,
    profileOverride,
    profileOverrideSource,
    persistDefaultSelection: true,
  });
  if (!updated) {
    return;
  }
  sessionStore[sessionKey] = sessionEntry;
  if (storePath) {
    updateSessionStore(storePath, (store) => {
      store[sessionKey] = sessionEntry;
    }).catch(() => {
      // Ignore persistence errors; session still proceeds.
    });
  }
}

export async function applyResetModelOverride(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  resetTriggered: boolean;
  bodyStripped?: string;
  sessionCtx: TemplateContext;
  ctx: MsgContext;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  modelCatalog?: ModelCatalogEntry[];
}): Promise<ResetModelResult> {
  if (!params.resetTriggered) {
    return {};
  }
  const rawBody = params.bodyStripped?.trim();
  if (!rawBody) {
    return {};
  }

  const { tokens, first, second } = splitBody(rawBody);
  if (!first) {
    return {};
  }

  const catalog = params.modelCatalog ?? (await loadModelCatalog({ config: params.cfg }));
  const allowed = buildAllowedModelSet({
    cfg: params.cfg,
    catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    agentId: params.agentId,
  });
  const allowedModelKeys = allowed.allowedKeys;
  if (allowedModelKeys.size === 0) {
    return {};
  }

  const providers = new Set<string>();
  for (const key of allowedModelKeys) {
    const slash = key.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    providers.add(normalizeProviderId(key.slice(0, slash)));
  }

  const resolveSelection = (raw: string) =>
    resolveModelDirectiveSelection({
      raw,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      aliasIndex: params.aliasIndex,
      allowedModelKeys,
    });

  let selection: ModelDirectiveSelection | undefined;
  let profileOverride: string | undefined;
  let profileOverrideSource: "auto" | "user" | undefined;
  let consumed = 0;
  let rawProfile: string | undefined;

  if (providers.has(normalizeProviderId(first)) && second) {
    const [modelPart, profilePart] = second.split("@", 2);
    const composite = `${normalizeProviderId(first)}/${modelPart}`;
    const resolved = resolveSelection(composite);
    if (resolved.selection) {
      selection = resolved.selection;
      consumed = 2;
      rawProfile = profilePart?.trim() || undefined;
    }
  }

  if (!selection) {
    const [modelPart, profilePart] = first.split("@", 2);
    selection = buildSelectionFromExplicit({
      raw: modelPart,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      aliasIndex: params.aliasIndex,
      allowedModelKeys,
    });
    if (selection) {
      consumed = 1;
      rawProfile = profilePart?.trim() || undefined;
    }
  }

  if (!selection) {
    const [modelPart, profilePart] = first.split("@", 2);
    const resolved = resolveSelection(modelPart);
    const allowFuzzy =
      providers.has(normalizeProviderId(modelPart)) || modelPart.trim().length >= 6;
    if (allowFuzzy) {
      selection = resolved.selection;
      if (selection) {
        consumed = 1;
        rawProfile = profilePart?.trim() || undefined;
      }
    }
  }

  if (!selection) {
    return {};
  }

  const cleanedBody = tokens.slice(consumed).join(" ").trim();
  const agentDir = params.agentId ? resolveAgentDir(params.cfg, params.agentId) : undefined;
  const resolvedProfile = resolveModelAuthProfile({
    rawProfile,
    provider: selection.provider,
    cfg: params.cfg,
    agentDir,
    sessionEntry: params.sessionEntry,
  });
  if (resolvedProfile.error) {
    const warningText = [`System: ${resolvedProfile.error}`, cleanedBody]
      .filter(Boolean)
      .join("\n\n");
    params.sessionCtx.Body = warningText;
    params.sessionCtx.BodyForAgent = warningText;
    params.sessionCtx.BodyStripped = warningText;
    params.sessionCtx.BodyForCommands = warningText;
    params.sessionCtx.CommandBody = warningText;
    params.sessionCtx.RawBody = warningText;
    return { cleanedBody, errorText: resolvedProfile.error };
  }
  profileOverride = resolvedProfile.profileId;
  profileOverrideSource = resolvedProfile.profileOverrideSource;
  const compatibility = validateModelAuthProfileCompatibility({
    provider: selection.provider,
    model: selection.model,
    profileId: profileOverride,
    agentDir,
  });
  if (compatibility.error) {
    const warningText = [`System: ${compatibility.error}`, cleanedBody]
      .filter(Boolean)
      .join("\n\n");
    params.sessionCtx.Body = warningText;
    params.sessionCtx.BodyForAgent = warningText;
    params.sessionCtx.BodyStripped = warningText;
    params.sessionCtx.BodyForCommands = warningText;
    params.sessionCtx.CommandBody = warningText;
    params.sessionCtx.RawBody = warningText;
    return { cleanedBody, errorText: compatibility.error };
  }

  params.sessionCtx.Body = cleanedBody;
  params.sessionCtx.BodyForAgent = cleanedBody;
  params.sessionCtx.BodyStripped = cleanedBody;
  params.sessionCtx.BodyForCommands = cleanedBody;
  params.sessionCtx.CommandBody = cleanedBody;
  params.sessionCtx.RawBody = cleanedBody;

  applySelectionToSession({
    selection,
    profileOverride,
    profileOverrideSource,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });

  return { selection, cleanedBody };
}
