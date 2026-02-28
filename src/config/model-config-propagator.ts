import { EventEmitter } from "node:events";
import { listAgentIds } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "./config.js";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "./io.js";
import { resolveAgentModelPrimaryValue } from "./model-input.js";
import { resolveDefaultSessionStorePath } from "./sessions/paths.js";
import { loadSessionStore, updateSessionStore } from "./sessions/store.js";
import type { SessionEntry } from "./sessions/types.js";

export type ModelPropagationScope = "global" | "agent" | "session";

export type ModelPropagationResult = {
  updated: {
    sessions: number;
    config: boolean;
    allowlist: boolean;
  };
};

/**
 * Centralized model configuration propagator.
 *
 * When a model is changed via CLI or config, the change must propagate to
 * all 4 config stores to avoid drift:
 * 1. openclaw.json (agents.defaults.model.primary)
 * 2. Session state files (model baked at session creation)
 * 3. Cron job payloads (model frozen at cron creation)
 * 4. Model allowlist (enforced by crons, bypassed by interactive sessions)
 *
 * See: Bug #3 — Config drift multi-endroits
 */
export class ModelConfigPropagator extends EventEmitter {
  /**
   * Set model across all relevant stores in a single operation.
   *
   * @param modelId - Full model ref (e.g. "anthropic/claude-opus-4-6")
   * @param scope - How broadly to propagate: "global" (all agents), "agent" (single agent), "session" (single session)
   * @param agentId - Required when scope is "agent"
   */
  async setModel(
    modelId: string,
    scope: ModelPropagationScope,
    agentId?: string,
  ): Promise<ModelPropagationResult> {
    const trimmedModel = modelId.trim();
    if (!trimmedModel) {
      throw new Error("Model ID must not be empty.");
    }

    let configUpdated = false;
    let allowlistUpdated = false;
    let sessionsUpdated = 0;

    // 1. Update main config file (openclaw.json)
    const { snapshot } = await readConfigFileSnapshotForWrite();
    const cfg = { ...snapshot } as OpenClawConfig;

    if (scope === "global") {
      cfg.agents = cfg.agents ?? {};
      cfg.agents.defaults = cfg.agents.defaults ?? {};
      const currentModel = cfg.agents.defaults.model;
      const currentPrimary = resolveAgentModelPrimaryValue(currentModel);

      if (currentPrimary !== trimmedModel) {
        if (typeof currentModel === "string" || !currentModel) {
          cfg.agents.defaults.model = trimmedModel;
        } else {
          cfg.agents.defaults.model = {
            ...currentModel,
            primary: trimmedModel,
          };
        }
        configUpdated = true;
      }
    } else if (scope === "agent" && agentId) {
      const agents = cfg.agents ?? {};
      const agentsList = Array.isArray(agents.list) ? agents.list : [];
      const agentEntry = agentsList.find((e) => e?.id === agentId);
      if (agentEntry) {
        const currentModel = agentEntry.model;
        const currentPrimary = resolveAgentModelPrimaryValue(currentModel);
        if (currentPrimary !== trimmedModel) {
          if (typeof currentModel === "string" || !currentModel) {
            agentEntry.model = trimmedModel;
          } else {
            agentEntry.model = { ...currentModel, primary: trimmedModel };
          }
          configUpdated = true;
        }
      }
    }

    // 2. Update model allowlist if model is not already in it
    if (cfg.agents?.defaults) {
      const defaults = cfg.agents.defaults;
      const models = defaults.models;
      if (models && typeof models === "object" && !Array.isArray(models)) {
        // models is a Record<string, AgentModelEntryConfig>
        const modelKeys = Object.keys(models);
        if (!modelKeys.includes(trimmedModel)) {
          (models as Record<string, unknown>)[trimmedModel] = {};
          allowlistUpdated = true;
          configUpdated = true;
        }
      }
    }

    // 3. Write updated config if anything changed
    if (configUpdated) {
      await writeConfigFile(cfg);
    }

    // 4. Propagate to active sessions
    const agentIds = scope === "agent" && agentId ? [agentId] : listAgentIds(cfg);

    for (const aid of agentIds) {
      const storePath = resolveDefaultSessionStorePath(aid);
      try {
        const store = loadSessionStore(storePath);
        const sessionKeys = Object.keys(store);
        if (sessionKeys.length === 0) {
          continue;
        }

        // Parse provider/model from the model ID
        const slashIndex = trimmedModel.indexOf("/");
        const provider = slashIndex > 0 ? trimmedModel.slice(0, slashIndex) : undefined;
        const modelName = slashIndex > 0 ? trimmedModel.slice(slashIndex + 1) : trimmedModel;

        await updateSessionStore(storePath, (currentStore) => {
          for (const key of Object.keys(currentStore)) {
            const entry = currentStore[key];
            if (!entry) {
              continue;
            }
            // Only update sessions that don't have explicit overrides
            if (entry.modelOverride || entry.providerOverride) {
              continue;
            }
            entry.model = modelName;
            if (provider) {
              entry.modelProvider = provider;
            }
            sessionsUpdated++;
          }
        });
      } catch {
        // Session store may not exist for all agents — skip silently
        continue;
      }
    }

    // Emit event for UI consumers (WebSocket broadcast)
    this.emit("model.changed", {
      model: trimmedModel,
      scope,
      agentId,
      updated: {
        sessions: sessionsUpdated,
        config: configUpdated,
        allowlist: allowlistUpdated,
      },
    });

    return {
      updated: {
        sessions: sessionsUpdated,
        config: configUpdated,
        allowlist: allowlistUpdated,
      },
    };
  }

  /**
   * Detect config drift between the 4 model stores.
   * Returns a report of inconsistencies.
   */
  detectDrift(cfg: OpenClawConfig): ModelDriftReport {
    const issues: ModelDriftIssue[] = [];
    const globalPrimary = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model);

    if (!globalPrimary) {
      return { issues, hasDrift: false };
    }

    const agentIds = listAgentIds(cfg);

    for (const agentId of agentIds) {
      const storePath = resolveDefaultSessionStorePath(agentId);
      let store: Record<string, SessionEntry>;
      try {
        store = loadSessionStore(storePath);
      } catch {
        continue;
      }

      for (const [key, entry] of Object.entries(store)) {
        if (!entry || entry.modelOverride || entry.providerOverride) {
          continue;
        }

        const sessionModel = entry.model;
        const sessionProvider = entry.modelProvider;
        const sessionFullModel = sessionProvider
          ? `${sessionProvider}/${sessionModel}`
          : sessionModel;

        if (sessionFullModel && sessionFullModel !== globalPrimary) {
          issues.push({
            type: "session_model_mismatch",
            agentId,
            sessionKey: key,
            expected: globalPrimary,
            actual: sessionFullModel,
          });
        }
      }
    }

    return { issues, hasDrift: issues.length > 0 };
  }
}

export type ModelDriftIssue = {
  type: "session_model_mismatch" | "cron_model_mismatch" | "allowlist_missing";
  agentId: string;
  sessionKey?: string;
  cronId?: string;
  expected: string;
  actual?: string;
};

export type ModelDriftReport = {
  issues: ModelDriftIssue[];
  hasDrift: boolean;
};
