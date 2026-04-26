/**
 * Outbound footer hook adapter.
 *
 * Pulls live runtime telemetry (context tokens, compactions, model alias)
 * from the session store, calls into the pure `processOutboundText` pipeline,
 * and persists threshold-warning state back to the session entry.
 *
 * Failures here must never break message delivery: any unexpected error
 * leaves the original text untouched and is swallowed silently.
 */

import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionStore,
  resolveStorePath,
  updateSessionStore,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  type FooterRenderVars,
  processOutboundText,
} from "../../utils/outbound-footer.js";

const DEFAULT_CONTEXT_WARNING_THRESHOLDS = [70, 85, 95];

export type ApplyOutboundFooterParams = {
  cfg: OpenClawConfig;
  text: string;
  /** Routing session key the message originates from; used for telemetry lookup. */
  sessionKey?: string;
  /** Active agent id for resolving the per-agent session store. */
  agentId?: string;
};

function resolveContextLimitFromAgentDefaults(cfg: OpenClawConfig): number | undefined {
  const explicit = cfg.agents?.defaults?.contextTokens;
  if (typeof explicit === "number" && explicit > 0) {
    return explicit;
  }
  return undefined;
}

function resolveModelAliasFromSession(
  entry: SessionEntry | undefined,
  cfg: OpenClawConfig,
): string | undefined {
  const provider = entry?.modelProvider?.trim() || entry?.providerOverride?.trim();
  const model = entry?.model?.trim() || entry?.modelOverride?.trim();
  if (provider && model) {
    return `${provider}/${model}`;
  }
  if (model) {
    return model;
  }
  // Fall back to agent default if session has not recorded a model yet.
  const defaultModel = cfg.agents?.defaults?.model;
  if (typeof defaultModel === "string" && defaultModel.trim()) {
    return defaultModel.trim();
  }
  if (
    defaultModel &&
    typeof defaultModel === "object" &&
    typeof defaultModel.primary === "string" &&
    defaultModel.primary.trim()
  ) {
    return defaultModel.primary.trim();
  }
  return undefined;
}

function loadFooterContext(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
}): {
  entry: SessionEntry | undefined;
  storePath: string | undefined;
  resolvedKey: string | undefined;
  vars: FooterRenderVars;
} {
  const cfg = params.cfg;
  let entry: SessionEntry | undefined;
  let storePath: string | undefined;
  let resolvedKey: string | undefined;
  if (params.sessionKey) {
    try {
      const agentId =
        params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
      storePath = resolveStorePath(cfg.session?.store, { agentId });
      const store = loadSessionStore(storePath);
      entry = store[params.sessionKey];
      if (entry) {
        resolvedKey = params.sessionKey;
      }
    } catch {
      entry = undefined;
      storePath = undefined;
    }
  }
  const contextTokens =
    typeof entry?.contextTokens === "number" && entry.contextTokens > 0
      ? entry.contextTokens
      : typeof entry?.totalTokens === "number" && entry.totalTokens > 0
        ? entry.totalTokens
        : undefined;
  const contextLimit = resolveContextLimitFromAgentDefaults(cfg);
  const compactions =
    typeof entry?.compactionCount === "number" ? entry.compactionCount : 0;
  const modelAlias = resolveModelAliasFromSession(entry, cfg);
  return {
    entry,
    storePath,
    resolvedKey,
    vars: {
      contextTokens,
      contextLimit,
      compactions,
      modelAlias,
    },
  };
}

/**
 * Apply the outbound footer + context-warning hook to a message body.
 *
 * Always strips any model-written footer, even when both features are
 * disabled: a fabricated footer is never wanted in user-facing text.
 *
 * Returns the original text on any failure.
 */
export async function applyOutboundFooterHook(
  params: ApplyOutboundFooterParams,
): Promise<string> {
  if (typeof params.text !== "string" || !params.text) {
    return params.text;
  }
  try {
    const messages = params.cfg.messages;
    const footerCfg = messages?.outboundFooter;
    const warningCfg = messages?.contextWarning;
    const footerEnabled = footerCfg?.enabled === true && Boolean(footerCfg?.template);
    const warningEnabled = warningCfg?.enabled === true;
    const ctx = loadFooterContext({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
    const thresholds =
      warningEnabled
        ? warningCfg?.thresholds && warningCfg.thresholds.length > 0
          ? warningCfg.thresholds
          : DEFAULT_CONTEXT_WARNING_THRESHOLDS
        : [];
    const alreadyWarned = ctx.entry?.contextWarningThresholdsTriggered ?? [];
    const result = processOutboundText({
      text: params.text,
      ...(footerEnabled
        ? {
            footer: {
              enabled: true,
              template: footerCfg!.template!,
              vars: ctx.vars,
            },
          }
        : {}),
      ...(warningEnabled
        ? {
            warning: {
              contextTokens: ctx.vars.contextTokens,
              contextLimit: ctx.vars.contextLimit,
              thresholds,
              alreadyWarned,
            },
          }
        : {}),
    });
    if (
      result.warningThresholdRecorded !== undefined &&
      ctx.storePath &&
      ctx.resolvedKey
    ) {
      const newThreshold = result.warningThresholdRecorded;
      const storePath = ctx.storePath;
      const sessionKey = ctx.resolvedKey;
      try {
        await updateSessionStore(storePath, (store) => {
          const current = store[sessionKey];
          if (!current) {
            return;
          }
          const triggered = new Set<number>(
            current.contextWarningThresholdsTriggered ?? [],
          );
          triggered.add(newThreshold);
          store[sessionKey] = {
            ...current,
            contextWarningThresholdsTriggered: [...triggered].sort((a, b) => a - b),
          };
        });
      } catch {
        // Persistence failures must not affect delivery.
      }
    }
    return result.text;
  } catch {
    return params.text;
  }
}
