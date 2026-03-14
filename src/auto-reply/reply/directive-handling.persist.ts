import { spawn } from "node:child_process";
import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import {
  buildModelAliasIndex,
  type ModelAliasIndex,
  modelKey,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import { type SessionEntry, updateSessionStore } from "../../config/sessions.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { killProcessTree } from "../../process/kill-tree.js";
import { applyVerboseOverride } from "../../sessions/level-overrides.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { resolveProfileOverride } from "./directive-handling.auth.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { enqueueModeSwitchEvents } from "./directive-handling.shared.js";
import type { ElevatedLevel, ReasoningLevel } from "./directives.js";

export async function persistInlineDirectives(params: {
  directives: InlineDirectives;
  effectiveModelDirective?: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  provider: string;
  model: string;
  initialModelLabel: string;
  formatModelSwitchEvent: (label: string, alias?: string) => string;
  agentCfg: NonNullable<OpenClawConfig["agents"]>["defaults"] | undefined;
  sessionId?: string;
}): Promise<{ provider: string; model: string; contextTokens: number; hookError?: string }> {
  const {
    directives,
    cfg,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    elevatedEnabled,
    elevatedAllowed,
    defaultProvider,
    defaultModel,
    aliasIndex,
    allowedModelKeys,
    initialModelLabel,
    formatModelSwitchEvent,
    agentCfg,
    sessionId,
  } = params;
  let { provider, model } = params;
  const activeAgentId = sessionKey
    ? resolveSessionAgentId({ sessionKey, config: cfg })
    : resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, activeAgentId);

  if (sessionEntry && sessionStore && sessionKey) {
    const prevElevatedLevel =
      (sessionEntry.elevatedLevel as ElevatedLevel | undefined) ??
      (agentCfg?.elevatedDefault as ElevatedLevel | undefined) ??
      (elevatedAllowed ? ("on" as ElevatedLevel) : ("off" as ElevatedLevel));
    const prevReasoningLevel = (sessionEntry.reasoningLevel as ReasoningLevel | undefined) ?? "off";
    let elevatedChanged =
      directives.hasElevatedDirective &&
      directives.elevatedLevel !== undefined &&
      elevatedEnabled &&
      elevatedAllowed;
    let reasoningChanged =
      directives.hasReasoningDirective && directives.reasoningLevel !== undefined;
    let updated = false;

    if (directives.hasThinkDirective && directives.thinkLevel) {
      sessionEntry.thinkingLevel = directives.thinkLevel;
      updated = true;
    }
    if (directives.hasVerboseDirective && directives.verboseLevel) {
      applyVerboseOverride(sessionEntry, directives.verboseLevel);
      updated = true;
    }
    if (directives.hasReasoningDirective && directives.reasoningLevel) {
      if (directives.reasoningLevel === "off") {
        // Persist explicit off so it overrides model-capability defaults.
        sessionEntry.reasoningLevel = "off";
      } else {
        sessionEntry.reasoningLevel = directives.reasoningLevel;
      }
      reasoningChanged =
        reasoningChanged ||
        (directives.reasoningLevel !== prevReasoningLevel &&
          directives.reasoningLevel !== undefined);
      updated = true;
    }
    if (
      directives.hasElevatedDirective &&
      directives.elevatedLevel &&
      elevatedEnabled &&
      elevatedAllowed
    ) {
      // Persist "off" explicitly so inline `/elevated off` overrides defaults.
      sessionEntry.elevatedLevel = directives.elevatedLevel;
      elevatedChanged =
        elevatedChanged ||
        (directives.elevatedLevel !== prevElevatedLevel && directives.elevatedLevel !== undefined);
      updated = true;
    }
    if (directives.hasExecDirective && directives.hasExecOptions) {
      if (directives.execHost) {
        sessionEntry.execHost = directives.execHost;
        updated = true;
      }
      if (directives.execSecurity) {
        sessionEntry.execSecurity = directives.execSecurity;
        updated = true;
      }
      if (directives.execAsk) {
        sessionEntry.execAsk = directives.execAsk;
        updated = true;
      }
      if (directives.execNode) {
        sessionEntry.execNode = directives.execNode;
        updated = true;
      }
    }

    const modelDirective =
      directives.hasModelDirective && params.effectiveModelDirective
        ? params.effectiveModelDirective
        : undefined;
    if (modelDirective) {
      const resolved = resolveModelRefFromString({
        raw: modelDirective,
        defaultProvider,
        aliasIndex,
      });
      if (resolved) {
        const key = modelKey(resolved.ref.provider, resolved.ref.model);
        if (allowedModelKeys.size === 0 || allowedModelKeys.has(key)) {
          // Run pre-model-change hook if configured (per-model config takes precedence over global)
          const targetModelCfg = params.agentCfg?.models?.[key];
          const hookCfg = targetModelCfg?.beforeModelChange ?? params.agentCfg?.beforeModelChange;
          if (hookCfg?.command) {
            const hookError = await runBeforeModelChangeHook({
              hookCfg,
              previousProvider: provider,
              previousModel: model,
              nextProvider: resolved.ref.provider,
              nextModel: resolved.ref.model,
              sessionId,
              agentId: activeAgentId,
            });
            if (hookError !== undefined) {
              return {
                provider,
                model,
                contextTokens:
                  agentCfg?.contextTokens ?? lookupContextTokens(model) ?? DEFAULT_CONTEXT_TOKENS,
                hookError,
              };
            }
          }

          let profileOverride: string | undefined;
          if (directives.rawModelProfile) {
            const profileResolved = resolveProfileOverride({
              rawProfile: directives.rawModelProfile,
              provider: resolved.ref.provider,
              cfg,
              agentDir,
            });
            if (profileResolved.error) {
              throw new Error(profileResolved.error);
            }
            profileOverride = profileResolved.profileId;
          }
          const isDefault =
            resolved.ref.provider === defaultProvider && resolved.ref.model === defaultModel;
          const { updated: modelUpdated } = applyModelOverrideToSessionEntry({
            entry: sessionEntry,
            selection: {
              provider: resolved.ref.provider,
              model: resolved.ref.model,
              isDefault,
            },
            profileOverride,
          });
          provider = resolved.ref.provider;
          model = resolved.ref.model;
          const nextLabel = `${provider}/${model}`;
          if (nextLabel !== initialModelLabel) {
            enqueueSystemEvent(formatModelSwitchEvent(nextLabel, resolved.alias), {
              sessionKey,
              contextKey: `model:${nextLabel}`,
            });
          }
          updated = updated || modelUpdated;
        }
      }
    }
    if (directives.hasQueueDirective && directives.queueReset) {
      delete sessionEntry.queueMode;
      delete sessionEntry.queueDebounceMs;
      delete sessionEntry.queueCap;
      delete sessionEntry.queueDrop;
      updated = true;
    }

    if (updated) {
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = sessionEntry;
        });
      }
      enqueueModeSwitchEvents({
        enqueueSystemEvent,
        sessionEntry,
        sessionKey,
        elevatedChanged,
        reasoningChanged,
      });
    }
  }

  return {
    provider,
    model,
    contextTokens: agentCfg?.contextTokens ?? lookupContextTokens(model) ?? DEFAULT_CONTEXT_TOKENS,
  };
}

/** Run the before_model_change hook. Returns error string on failure, undefined on success. */
export async function runBeforeModelChangeHook(params: {
  hookCfg: { command: string; timeoutSeconds?: number };
  previousProvider: string;
  previousModel: string;
  nextProvider: string;
  nextModel: string;
  sessionId?: string;
  agentId?: string;
}): Promise<string | undefined> {
  const { hookCfg, previousProvider, previousModel, nextProvider, nextModel, sessionId, agentId } =
    params;
  const timeoutMs = (hookCfg.timeoutSeconds ?? 30) * 1000;
  const command = hookCfg.command
    .replace(/\{provider\}/g, nextProvider)
    .replace(/\{model\}/g, nextModel)
    .replace(/\{previousProvider\}/g, previousProvider)
    .replace(/\{previousModel\}/g, previousModel)
    .replace(/\{sessionId\}/g, sessionId ?? "")
    .replace(/\{agentId\}/g, agentId ?? "");
  return new Promise((resolve) => {
    const { shell, args: shellArgs } = (() => {
      const sh = process.env.SHELL || "/bin/sh";
      return { shell: sh, args: ["-c"] };
    })();
    const proc = spawn(shell, [...shellArgs, command], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      if (proc.pid) {
        killProcessTree(proc.pid);
      }
      resolve(`Hook timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(err.message);
    });
    proc.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve((stdout || stderr || `Hook exited with code ${code}`).trim());
      } else {
        resolve(undefined);
      }
    });
  });
}

export function resolveDefaultModel(params: { cfg: OpenClawConfig; agentId?: string }): {
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
} {
  const mainModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const defaultProvider = mainModel.provider;
  const defaultModel = mainModel.model;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider,
  });
  return { defaultProvider, defaultModel, aliasIndex };
}
