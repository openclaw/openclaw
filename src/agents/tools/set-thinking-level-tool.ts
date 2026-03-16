import { Type } from "@sinclair/typebox";
import {
  formatEffectiveThinkingResolution,
  formatThinkingLevels,
  normalizeThinkLevel,
  resolveEffectiveThinking,
  resolveThinkingCapabilities,
  supportsXHighThinking,
  type ThinkLevel,
} from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  resolveStorePath,
  resolveSessionStoreEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { applySessionsPatchToStore } from "../../gateway/sessions-patch.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, jsonResult, readStringParam } from "./common.js";

const SET_THINKING_LEVEL_SCOPES = ["turn", "session"] as const;

const SetThinkingLevelToolSchema = Type.Object({
  level: Type.String(),
  scope: stringEnum(SET_THINKING_LEVEL_SCOPES),
});

function resolveToolThinkingLevel(params: {
  raw: string;
  provider?: string;
  modelId?: string;
}): ThinkLevel {
  const normalized = normalizeThinkLevel(params.raw);
  if (!normalized) {
    throw new ToolInputError(
      `Invalid thinking level "${params.raw}". Use one of: ${formatThinkingLevels(
        params.provider,
        params.modelId,
        "|",
      )}.`,
    );
  }
  if (normalized === "xhigh" && !supportsXHighThinking(params.provider, params.modelId)) {
    throw new ToolInputError(
      `Invalid thinking level "${params.raw}". Use one of: ${formatThinkingLevels(
        params.provider,
        params.modelId,
        "|",
      )}.`,
    );
  }
  return normalized;
}

function resolveToolThinkingScope(raw: string): "turn" | "session" {
  if (raw === "turn" || raw === "session") {
    return raw;
  }
  throw new ToolInputError(`Invalid scope "${raw}". Use one of: turn|session.`);
}

function resolveSetThinkingLevelArgs(args: Record<string, unknown>): {
  level: string;
  scope: "turn" | "session";
} {
  const structuredLevel = typeof args.level === "string" ? args.level.trim() : "";
  const structuredScope = typeof args.scope === "string" ? args.scope.trim() : "";
  if (structuredLevel && structuredScope) {
    return {
      level: structuredLevel,
      scope: resolveToolThinkingScope(structuredScope),
    };
  }

  const rawCommand = typeof args.command === "string" ? args.command.trim() : "";
  if (!rawCommand) {
    return {
      level: readStringParam(args, "level", { required: true }),
      scope: resolveToolThinkingScope(readStringParam(args, "scope", { required: true })),
    };
  }

  const tokenMap = new Map<string, string>();
  const positional: string[] = [];
  for (const token of rawCommand.split(/\s+/).filter(Boolean)) {
    const eqIndex = token.indexOf("=");
    if (eqIndex > 0) {
      tokenMap.set(token.slice(0, eqIndex).toLowerCase(), token.slice(eqIndex + 1));
      continue;
    }
    positional.push(token);
  }

  const rawLevel = tokenMap.get("level") ?? positional.find((token) => normalizeThinkLevel(token));
  const rawScope =
    tokenMap.get("scope") ?? positional.find((token) => token === "turn" || token === "session");

  if (!rawLevel) {
    throw new ToolInputError('Missing required parameter "level".');
  }
  if (!rawScope) {
    throw new ToolInputError('Missing required parameter "scope".');
  }

  return {
    level: rawLevel,
    scope: resolveToolThinkingScope(rawScope),
  };
}

export function createSetThinkingLevelTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
  provider?: string;
  modelId?: string;
  reasoningSupported?: boolean;
  getRequestedThinkingLevel?: () => ThinkLevel | undefined;
  setRequestedThinkingLevelForScope?: (scope: "turn" | "session", level: ThinkLevel) => void;
  applyEffectiveThinkingLevel?: (level: ThinkLevel) => void;
}): AnyAgentTool {
  const options = opts ?? {};
  return {
    label: "Set Thinking Level",
    name: "set_thinking_level",
    description:
      "Change thinking level for the current run or session default; use `turn` for temporary one-off hard tasks and `session` for lasting or user-requested changes.",
    parameters: SetThinkingLevelToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const { level: levelRaw, scope } = resolveSetThinkingLevelArgs(params);
      const cfg = options.config ?? loadConfig();
      const priorRequestedLevel = options.getRequestedThinkingLevel?.();
      if (
        scope === "turn" &&
        (!options.setRequestedThinkingLevelForScope || !options.applyEffectiveThinkingLevel)
      ) {
        throw new ToolInputError("turn scope requires an active run thinking state");
      }
      if (scope === "session" && !options.agentSessionKey) {
        throw new ToolInputError("session scope requires an active agent session");
      }

      const requestedLevel = resolveToolThinkingLevel({
        raw: levelRaw,
        provider: options.provider,
        modelId: options.modelId,
      });
      const requestedResolution = resolveEffectiveThinking({
        requested: requestedLevel,
        capabilities: resolveThinkingCapabilities({
          provider: options.provider,
          model: options.modelId,
          reasoningSupported: options.reasoningSupported,
        }),
      });
      let persisted = false;
      if (scope === "session") {
        await persistThinkingLevelPatch({
          cfg,
          sessionKey: options.agentSessionKey!,
          value: requestedLevel,
        });
        persisted = true;
      }
      options.setRequestedThinkingLevelForScope?.(scope, requestedLevel);

      if (requestedResolution.status === "unsupported") {
        options.applyEffectiveThinkingLevel?.("off");
        return jsonResult({
          ok: true,
          priorRequestedLevel: priorRequestedLevel ?? null,
          currentRequestedLevel: requestedLevel,
          effectiveLevel: "off",
          scope,
          persisted,
          explanation:
            formatEffectiveThinkingResolution(requestedResolution) ?? "Unsupported thinking level",
        });
      }

      const effectiveLevel = requestedResolution.effective;
      const runtimeEffectiveLevel = effectiveLevel === "on" ? "low" : effectiveLevel;

      options.applyEffectiveThinkingLevel?.(runtimeEffectiveLevel);

      return jsonResult({
        ok: true,
        priorRequestedLevel: priorRequestedLevel ?? null,
        currentRequestedLevel: requestedLevel,
        effectiveLevel,
        scope,
        persisted,
        explanation: formatEffectiveThinkingResolution(requestedResolution),
      });
    },
  };
}

async function persistThinkingLevelPatch(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  value: ThinkLevel | null;
}): Promise<void> {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  await updateSessionStore(storePath, async (store) => {
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    if (resolved.existing) {
      store[resolved.normalizedKey] = resolved.existing;
      for (const legacyKey of resolved.legacyKeys) {
        delete store[legacyKey];
      }
    }
    const applied = await applySessionsPatchToStore({
      cfg: params.cfg,
      store,
      storeKey: resolved.normalizedKey,
      patch: {
        key: resolved.normalizedKey,
        thinkingLevel: params.value,
      },
    });
    if (!applied.ok) {
      throw new ToolInputError(applied.error.message);
    }
    return applied;
  });
}
