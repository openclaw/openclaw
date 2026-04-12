import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  getModelRefStatus,
  loadModelCatalog,
  normalizeModelSelection,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "./run.runtime.js";

type CronSessionModelOverrides = {
  modelOverride?: string;
  providerOverride?: string;
};

export type ResolveCronModelSelectionParams = {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  agentConfigOverride?: {
    model?: unknown;
    subagents?: {
      model?: unknown;
    };
  };
  sessionEntry: CronSessionModelOverrides;
  payload: CronJob["payload"];
  isGmailHook: boolean;
};

export type ResolveCronModelSelectionResult =
  | {
      ok: true;
      provider: string;
      model: string;
      warning?: string;
    }
  | {
      ok: false;
      error: string;
    };

export async function resolveCronModelSelection(
  params: ResolveCronModelSelectionParams,
): Promise<ResolveCronModelSelectionResult> {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg: params.cfgWithAgentDefaults,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  let provider = resolvedDefault.provider;
  let model = resolvedDefault.model;

  let catalog: Awaited<ReturnType<typeof loadModelCatalog>> | undefined;
  const loadCatalogOnce = async () => {
    if (!catalog) {
      catalog = await loadModelCatalog({ config: params.cfgWithAgentDefaults });
    }
    return catalog;
  };

  const subagentModelRaw =
    normalizeModelSelection(params.agentConfigOverride?.subagents?.model) ??
    normalizeModelSelection(params.agentConfigOverride?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model);
  if (subagentModelRaw) {
    const resolvedSubagent = resolveAllowedModelRef({
      cfg: params.cfgWithAgentDefaults,
      catalog: await loadCatalogOnce(),
      raw: subagentModelRaw,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if (!("error" in resolvedSubagent)) {
      provider = resolvedSubagent.ref.provider;
      model = resolvedSubagent.ref.model;
    }
  }

  let hooksGmailModelApplied = false;
  const hooksGmailModelRef = params.isGmailHook
    ? resolveHooksGmailModel({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
      })
    : null;
  if (hooksGmailModelRef) {
    const status = getModelRefStatus({
      cfg: params.cfg,
      catalog: await loadCatalogOnce(),
      ref: hooksGmailModelRef,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if (status.allowed) {
      provider = hooksGmailModelRef.provider;
      model = hooksGmailModelRef.model;
      hooksGmailModelApplied = true;
    }
  }

  const modelOverrideRaw = params.payload.kind === "agentTurn" ? params.payload.model : undefined;
  const modelOverride = typeof modelOverrideRaw === "string" ? modelOverrideRaw.trim() : undefined;
  if (modelOverride !== undefined && modelOverride.length > 0) {
    const resolvedOverride = resolveAllowedModelRef({
      cfg: params.cfgWithAgentDefaults,
      catalog: await loadCatalogOnce(),
      raw: modelOverride,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if ("error" in resolvedOverride) {
      if (resolvedOverride.error.startsWith("model not allowed:")) {
        // payload.model is an explicit per-job override declared by the user in the
        // job config. Unlike ad-hoc requests, the intent is unambiguous — apply it
        // even when the model is not in agents.defaults.models allowlist, as long
        // as the model exists in the catalog (i.e. the provider is configured).
        // Silently falling back to the agent default here causes the bug reported
        // in #65129: the configured model is stored correctly but never used.
        const catalog = await loadCatalogOnce();
        const inCatalog = catalog.some(
          (entry) =>
            `${entry.provider}/${entry.id}` === modelOverride ||
            modelOverride.endsWith(`/${entry.id}`),
        );
        if (inCatalog) {
          // Re-resolve without the allowlist constraint by temporarily patching
          // the params to treat all catalog models as allowed.
          const relaxedOverride = resolveAllowedModelRef({
            cfg: {
              ...params.cfgWithAgentDefaults,
              agents: {
                ...params.cfgWithAgentDefaults.agents,
                defaults: {
                  ...params.cfgWithAgentDefaults.agents?.defaults,
                  models: {},  // empty = allowAny
                },
              },
            },
            catalog,
            raw: modelOverride,
            defaultProvider: resolvedDefault.provider,
            defaultModel: resolvedDefault.model,
          });
          if (!("error" in relaxedOverride)) {
            provider = relaxedOverride.ref.provider;
            model = relaxedOverride.ref.model;
          } else {
            return {
              ok: true,
              provider,
              model,
              warning: `cron: payload.model '${modelOverride}' not allowed and not in catalog, falling back to agent defaults`,
            };
          }
        } else {
          return {
            ok: true,
            provider,
            model,
            warning: `cron: payload.model '${modelOverride}' not in catalog (provider may not be configured), falling back to agent defaults`,
          };
        }
      } else {
        return { ok: false, error: resolvedOverride.error };
      }
    } else {
      provider = resolvedOverride.ref.provider;
      model = resolvedOverride.ref.model;
    }
  }

  if (!modelOverride && !hooksGmailModelApplied) {
    const sessionModelOverride = params.sessionEntry.modelOverride?.trim();
    if (sessionModelOverride) {
      const sessionProviderOverride =
        params.sessionEntry.providerOverride?.trim() || resolvedDefault.provider;
      const resolvedSessionOverride = resolveAllowedModelRef({
        cfg: params.cfgWithAgentDefaults,
        catalog: await loadCatalogOnce(),
        raw: `${sessionProviderOverride}/${sessionModelOverride}`,
        defaultProvider: resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
      });
      if (!("error" in resolvedSessionOverride)) {
        provider = resolvedSessionOverride.ref.provider;
        model = resolvedSessionOverride.ref.model;
      }
    }
  }

  return { ok: true, provider, model };
}
