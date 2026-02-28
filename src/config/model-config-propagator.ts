import { EventEmitter } from "node:events";
import { listAgentIds, resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
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
   * @param modelId    - Full model ref (e.g. "anthropic/claude-opus-4-6")
   * @param scope      - Propagation breadth:
   *   - "global"  → update openclaw.json defaults + all sessions for all agents
   *   - "agent"   → update openclaw.json agent entry + sessions for that agent only
   *   - "session" → update one specific session entry only (no config file change)
   * @param agentId    - Required for "agent" scope; identifies the agent whose sessions to update
   * @param sessionKey - Required for "session" scope; identifies the exact session to update
   */
  async setModel(
    modelId: string,
    scope: ModelPropagationScope,
    agentId?: string,
    sessionKey?: string,
  ): Promise<ModelPropagationResult> {
    const trimmedModel = modelId.trim();
    if (!trimmedModel) {
      throw new Error("Model ID must not be empty.");
    }

    // "session" scope requires both agentId and sessionKey to avoid accidentally
    // overwriting all sessions (P1 fix: prevent scope fall-through).
    if (scope === "session" && (!agentId || !sessionKey)) {
      throw new Error('setModel with scope="session" requires both agentId and sessionKey.');
    }

    let configUpdated = false;
    let allowlistUpdated = false;
    let sessionsUpdated = 0;

    // Parse provider/model from the model ID once, for session writes below.
    const slashIndex = trimmedModel.indexOf("/");
    const provider = slashIndex > 0 ? trimmedModel.slice(0, slashIndex) : undefined;
    const modelName = slashIndex > 0 ? trimmedModel.slice(slashIndex + 1) : trimmedModel;

    // 1. Update main config file (openclaw.json) — not for session-scoped changes
    if (scope !== "session") {
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
            cfg.agents.defaults.model = { ...currentModel, primary: trimmedModel };
          }
          configUpdated = true;
        }
      } else if (scope === "agent" && agentId) {
        const agentsList = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
        const agentEntry = agentsList.find((e) => e?.id === agentId);
        if (agentEntry) {
          const currentModel = agentEntry.model;
          const currentPrimary = resolveAgentModelPrimaryValue(currentModel);
          if (currentPrimary !== trimmedModel) {
            agentEntry.model =
              typeof currentModel === "string" || !currentModel
                ? trimmedModel
                : { ...currentModel, primary: trimmedModel };
            configUpdated = true;
          }
        }
      }

      // 2. Update model allowlist if model is not already in it
      const defaults = cfg.agents?.defaults;
      if (defaults) {
        const models = defaults.models;
        if (models && typeof models === "object" && !Array.isArray(models)) {
          if (!Object.keys(models).includes(trimmedModel)) {
            (models as Record<string, unknown>)[trimmedModel] = {};
            allowlistUpdated = true;
            configUpdated = true;
          }
        }
      }

      if (configUpdated) {
        await writeConfigFile(cfg);
      }
    }

    // 3. Propagate to sessions — scope determines which sessions to touch.
    if (scope === "session" && agentId && sessionKey) {
      // P1 fix: "session" scope updates exactly one session entry, nothing else.
      const storePath = resolveDefaultSessionStorePath(agentId);
      try {
        await updateSessionStore(storePath, (store) => {
          const entry = store[sessionKey];
          if (entry && !entry.modelOverride && !entry.providerOverride) {
            entry.model = modelName;
            if (provider) {
              entry.modelProvider = provider;
            }
            sessionsUpdated++;
          }
        });
      } catch {
        // Store may not exist yet — ignore
      }
    } else {
      // "global" or "agent": re-read updated config for agent list resolution
      const { snapshot: freshCfg } = await readConfigFileSnapshotForWrite();
      const resolvedCfg = freshCfg as OpenClawConfig;
      const agentIds = scope === "agent" && agentId ? [agentId] : listAgentIds(resolvedCfg);

      for (const aid of agentIds) {
        const storePath = resolveDefaultSessionStorePath(aid);
        try {
          const probe = loadSessionStore(storePath);
          if (Object.keys(probe).length === 0) {
            continue;
          }
          await updateSessionStore(storePath, (currentStore) => {
            for (const key of Object.keys(currentStore)) {
              const entry = currentStore[key];
              if (!entry || entry.modelOverride || entry.providerOverride) {
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
        }
      }
    }

    this.emit("model.changed", {
      model: trimmedModel,
      scope,
      agentId,
      sessionKey,
      updated: { sessions: sessionsUpdated, config: configUpdated, allowlist: allowlistUpdated },
    });

    return {
      updated: { sessions: sessionsUpdated, config: configUpdated, allowlist: allowlistUpdated },
    };
  }

  /**
   * Detect config drift between session stores and the effective model for each agent.
   *
   * P2 fix: compare each session against its agent's *effective* model
   * (which may be a per-agent override), not just the global default.
   * This prevents false positives when agents intentionally use different models.
   */
  detectDrift(cfg: OpenClawConfig): ModelDriftReport {
    const issues: ModelDriftIssue[] = [];
    const agentIds = listAgentIds(cfg);

    for (const agentId of agentIds) {
      // Use the effective model for this agent (agent override > global default).
      const effectivePrimary = resolveAgentEffectiveModelPrimary(cfg, agentId);
      if (!effectivePrimary) {
        continue;
      }

      const storePath = resolveDefaultSessionStorePath(agentId);
      let store: Record<string, SessionEntry>;
      try {
        store = loadSessionStore(storePath);
      } catch {
        continue;
      }

      for (const [key, entry] of Object.entries(store)) {
        // Skip sessions that have deliberate per-session overrides.
        if (!entry || entry.modelOverride || entry.providerOverride) {
          continue;
        }

        const sessionModel = entry.model;
        const sessionProvider = entry.modelProvider;
        const sessionFullModel = sessionProvider
          ? `${sessionProvider}/${sessionModel}`
          : sessionModel;

        if (sessionFullModel && sessionFullModel !== effectivePrimary) {
          issues.push({
            type: "session_model_mismatch",
            agentId,
            sessionKey: key,
            expected: effectivePrimary,
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
