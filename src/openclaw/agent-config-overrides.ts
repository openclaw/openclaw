/**
 * Fork-specific agent configuration overrides.
 *
 * This file isolates OpenClaw fork extensions from upstream code to minimize
 * merge conflicts. All per-agent thinking/verbose level resolution logic lives here.
 */

import type { ThinkLevel, VerboseLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveAgentThinkingDefault, resolveAgentVerboseDefault } from "../agents/agent-scope.js";

export { resolveAgentThinkingDefault, resolveAgentVerboseDefault };

/**
 * Resolve effective thinking level with fork-specific per-agent override support.
 *
 * Resolution order:
 * 1. Directive override (e.g., /think medium)
 * 2. Session-level override (persisted from previous directive)
 * 3. **Per-agent default (FORK EXTENSION)**
 * 4. Global agent default
 * 5. Model-based fallback (if async callback provided)
 *
 * @returns ThinkLevel if resolved synchronously, Promise if modelFallback is async
 */
export function resolveForkThinkingLevel(params: {
  directives?: { thinkLevel?: ThinkLevel };
  sessionEntry?: SessionEntry;
  cfg: OpenClawConfig;
  agentId: string;
  agentCfg?: NonNullable<OpenClawConfig["agents"]>["defaults"];
  modelFallback?: () => Promise<ThinkLevel | undefined>;
}): ThinkLevel | undefined | Promise<ThinkLevel | undefined> {
  const fromDirective = params.directives?.thinkLevel;
  if (fromDirective) {
    return fromDirective;
  }

  const fromSession = params.sessionEntry?.thinkingLevel as ThinkLevel | undefined;
  if (fromSession) {
    return fromSession;
  }

  // FORK EXTENSION: Check per-agent override
  const perAgent = resolveAgentThinkingDefault(params.cfg, params.agentId);
  if (perAgent) {
    return perAgent;
  }

  // Fall back to global default
  const globalDefault = params.agentCfg?.thinkingDefault as ThinkLevel | undefined;
  if (globalDefault) {
    return globalDefault;
  }

  // Model-based fallback (if provided)
  if (params.modelFallback) {
    return params.modelFallback();
  }

  return undefined;
}

/**
 * Synchronous version of resolveForkThinkingLevel (without model fallback).
 */
export function resolveForkThinkingLevelSync(params: {
  directives?: { thinkLevel?: ThinkLevel };
  sessionEntry?: SessionEntry;
  cfg: OpenClawConfig;
  agentId?: string;
  agentCfg?: NonNullable<OpenClawConfig["agents"]>["defaults"];
}): ThinkLevel | undefined {
  const fromDirective = params.directives?.thinkLevel;
  if (fromDirective) {
    return fromDirective;
  }

  const fromSession = params.sessionEntry?.thinkingLevel as ThinkLevel | undefined;
  if (fromSession) {
    return fromSession;
  }

  // FORK EXTENSION: Check per-agent override
  if (params.agentId) {
    const perAgent = resolveAgentThinkingDefault(params.cfg, params.agentId);
    if (perAgent) {
      return perAgent;
    }
  }

  // Fall back to global default
  return params.agentCfg?.thinkingDefault as ThinkLevel | undefined;
}

/**
 * Resolve effective verbose level with fork-specific per-agent override support.
 *
 * Resolution order:
 * 1. Directive override (e.g., /verbose on)
 * 2. Session-level override
 * 3. **Per-agent default (FORK EXTENSION)**
 * 4. Global agent default
 */
export function resolveForkVerboseLevel(params: {
  directives?: { verboseLevel?: VerboseLevel };
  sessionEntry?: SessionEntry;
  cfg: OpenClawConfig;
  agentId?: string;
  agentCfg?: NonNullable<OpenClawConfig["agents"]>["defaults"];
}): VerboseLevel | undefined {
  const fromDirective = params.directives?.verboseLevel;
  if (fromDirective) {
    return fromDirective;
  }

  const fromSession = params.sessionEntry?.verboseLevel as VerboseLevel | undefined;
  if (fromSession) {
    return fromSession;
  }

  // FORK EXTENSION: Check per-agent override
  if (params.agentId) {
    const perAgent = resolveAgentVerboseDefault(params.cfg, params.agentId);
    if (perAgent) {
      return perAgent;
    }
  }

  // Fall back to global default
  return params.agentCfg?.verboseDefault as VerboseLevel | undefined;
}
