import type { OpenClawConfig } from "../config/config.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import type { ContextEngine } from "./types.js";

/**
 * A factory that creates a ContextEngine instance.
 * Supports async creation for engines that need DB connections etc.
 */
export type ContextEngineFactory = () => ContextEngine | Promise<ContextEngine>;
export type ContextEngineRegistrationResult = { ok: true } | { ok: false; existingOwner: string };

type RegisterContextEngineForOwnerOptions = {
  allowSameOwnerRefresh?: boolean;
};

const LEGACY_SESSION_KEY_COMPAT = Symbol.for("openclaw.contextEngine.sessionKeyCompat");
const SESSION_KEY_COMPAT_METHODS = [
  "bootstrap",
  "maintain",
  "ingest",
  "ingestBatch",
  "afterTurn",
  "assemble",
  "compact",
] as const;

type SessionKeyCompatMethodName = (typeof SESSION_KEY_COMPAT_METHODS)[number];
type SessionKeyCompatParams = {
  sessionKey?: string;
};

function isSessionKeyCompatMethodName(value: PropertyKey): value is SessionKeyCompatMethodName {
  return (
    typeof value === "string" && (SESSION_KEY_COMPAT_METHODS as readonly string[]).includes(value)
  );
}

function hasOwnSessionKey(params: unknown): params is SessionKeyCompatParams {
  return (
    params !== null &&
    typeof params === "object" &&
    Object.prototype.hasOwnProperty.call(params, "sessionKey")
  );
}

function withoutSessionKey<T extends SessionKeyCompatParams>(params: T): T {
  const legacyParams = { ...params };
  delete legacyParams.sessionKey;
  return legacyParams;
}

function issueRejectsSessionKeyStrictly(issue: unknown): boolean {
  if (!issue || typeof issue !== "object") {
    return false;
  }

  const issueRecord = issue as {
    code?: unknown;
    keys?: unknown;
    message?: unknown;
  };
  if (
    issueRecord.code === "unrecognized_keys" &&
    Array.isArray(issueRecord.keys) &&
    issueRecord.keys.some((key) => key === "sessionKey")
  ) {
    return true;
  }

  return isSessionKeyCompatibilityError(issueRecord.message);
}

function* iterateErrorChain(error: unknown) {
  let current = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    yield current;
    seen.add(current);
    if (typeof current !== "object") {
      break;
    }
    current = (current as { cause?: unknown }).cause;
  }
}

const SESSION_KEY_UNKNOWN_FIELD_PATTERNS = [
  /\bunrecognized key(?:\(s\)|s)? in object:.*['"`]sessionKey['"`]/i,
  /\badditional propert(?:y|ies)\b.*['"`]sessionKey['"`]/i,
  /\bmust not have additional propert(?:y|ies)\b.*['"`]sessionKey['"`]/i,
  /\b(?:unexpected|extraneous)\s+(?:property|properties|field|fields|key|keys)\b.*['"`]sessionKey['"`]/i,
  /\b(?:unknown|invalid)\s+(?:property|properties|field|fields|key|keys)\b.*['"`]sessionKey['"`]/i,
  /['"`]sessionKey['"`].*\b(?:was|is)\s+not allowed\b/i,
  /"code"\s*:\s*"unrecognized_keys"[^]*"sessionKey"/i,
] as const;

function isSessionKeyUnknownFieldValidationMessage(message: string): boolean {
  return SESSION_KEY_UNKNOWN_FIELD_PATTERNS.some((pattern) => pattern.test(message));
}

function isSessionKeyCompatibilityError(error: unknown): boolean {
  for (const candidate of iterateErrorChain(error)) {
    if (Array.isArray(candidate)) {
      if (candidate.some((entry) => issueRejectsSessionKeyStrictly(entry))) {
        return true;
      }
      continue;
    }

    if (typeof candidate === "string") {
      if (isSessionKeyUnknownFieldValidationMessage(candidate)) {
        return true;
      }
      continue;
    }

    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const issueContainer = candidate as {
      message?: unknown;
      issues?: unknown;
      errors?: unknown;
    };

    if (
      Array.isArray(issueContainer.issues) &&
      issueContainer.issues.some((issue) => issueRejectsSessionKeyStrictly(issue))
    ) {
      return true;
    }

    if (
      Array.isArray(issueContainer.errors) &&
      issueContainer.errors.some((issue) => issueRejectsSessionKeyStrictly(issue))
    ) {
      return true;
    }

    if (
      typeof issueContainer.message === "string" &&
      isSessionKeyUnknownFieldValidationMessage(issueContainer.message)
    ) {
      return true;
    }
  }

  return false;
}

async function invokeWithLegacySessionKeyCompat<TResult, TParams extends SessionKeyCompatParams>(
  method: (params: TParams) => Promise<TResult> | TResult,
  params: TParams,
  opts?: {
    onLegacyModeDetected?: () => void;
  },
): Promise<TResult> {
  if (!hasOwnSessionKey(params)) {
    return await method(params);
  }

  try {
    return await method(params);
  } catch (error) {
    if (!isSessionKeyCompatibilityError(error)) {
      throw error;
    }
    opts?.onLegacyModeDetected?.();
    return await method(withoutSessionKey(params));
  }
}

function wrapContextEngineWithSessionKeyCompat(engine: ContextEngine): ContextEngine {
  const marked = engine as ContextEngine & {
    [LEGACY_SESSION_KEY_COMPAT]?: boolean;
  };
  if (marked[LEGACY_SESSION_KEY_COMPAT]) {
    return engine;
  }

  let isLegacy = false;
  const proxy: ContextEngine = new Proxy(engine, {
    get(target, property, receiver) {
      if (property === LEGACY_SESSION_KEY_COMPAT) {
        return true;
      }

      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }

      if (!isSessionKeyCompatMethodName(property)) {
        return value.bind(target);
      }

      return (params: SessionKeyCompatParams) => {
        const method = value.bind(target) as (params: SessionKeyCompatParams) => unknown;
        if (isLegacy && hasOwnSessionKey(params)) {
          return method(withoutSessionKey(params));
        }
        return invokeWithLegacySessionKeyCompat(method, params, {
          onLegacyModeDetected: () => {
            isLegacy = true;
          },
        });
      };
    },
  });
  return proxy;
}

// ---------------------------------------------------------------------------
// Registry (module-level singleton)
// ---------------------------------------------------------------------------

const CONTEXT_ENGINE_REGISTRY_STATE = Symbol.for("openclaw.contextEngineRegistryState");
const CORE_CONTEXT_ENGINE_OWNER = "core";
const PUBLIC_CONTEXT_ENGINE_OWNER = "public-sdk";

type ContextEngineRegistryState = {
  engines: Map<
    string,
    {
      factory: ContextEngineFactory;
      owner: string;
    }
  >;
};

// Keep context-engine registrations process-global so duplicated dist chunks
// still share one registry map at runtime.
function getContextEngineRegistryState(): ContextEngineRegistryState {
  const globalState = globalThis as typeof globalThis & {
    [CONTEXT_ENGINE_REGISTRY_STATE]?: ContextEngineRegistryState;
  };
  if (!globalState[CONTEXT_ENGINE_REGISTRY_STATE]) {
    globalState[CONTEXT_ENGINE_REGISTRY_STATE] = {
      engines: new Map(),
    };
  }
  return globalState[CONTEXT_ENGINE_REGISTRY_STATE];
}

function requireContextEngineOwner(owner: string): string {
  const normalizedOwner = owner.trim();
  if (!normalizedOwner) {
    throw new Error(
      `registerContextEngineForOwner: owner must be a non-empty string, got ${JSON.stringify(owner)}`,
    );
  }
  return normalizedOwner;
}

/**
 * Register a context engine implementation under an explicit trusted owner.
 */
export function registerContextEngineForOwner(
  id: string,
  factory: ContextEngineFactory,
  owner: string,
  opts?: RegisterContextEngineForOwnerOptions,
): ContextEngineRegistrationResult {
  const normalizedOwner = requireContextEngineOwner(owner);
  const registry = getContextEngineRegistryState().engines;
  const existing = registry.get(id);
  if (
    id === defaultSlotIdForKey("contextEngine") &&
    normalizedOwner !== CORE_CONTEXT_ENGINE_OWNER
  ) {
    return { ok: false, existingOwner: CORE_CONTEXT_ENGINE_OWNER };
  }
  if (existing && existing.owner !== normalizedOwner) {
    return { ok: false, existingOwner: existing.owner };
  }
  if (existing && opts?.allowSameOwnerRefresh !== true) {
    return { ok: false, existingOwner: existing.owner };
  }
  registry.set(id, { factory, owner: normalizedOwner });
  return { ok: true };
}

/**
 * Public SDK entry point for third-party registrations.
 *
 * This path is intentionally unprivileged: it cannot claim core-owned ids and
 * it cannot safely refresh an existing registration because the caller's
 * identity is not authenticated.
 */
export function registerContextEngine(
  id: string,
  factory: ContextEngineFactory,
): ContextEngineRegistrationResult {
  return registerContextEngineForOwner(id, factory, PUBLIC_CONTEXT_ENGINE_OWNER);
}

/**
 * Return the factory for a registered engine, or undefined.
 */
export function getContextEngineFactory(id: string): ContextEngineFactory | undefined {
  return getContextEngineRegistryState().engines.get(id)?.factory;
}

/**
 * List all registered engine ids.
 */
export function listContextEngineIds(): string[] {
  return [...getContextEngineRegistryState().engines.keys()];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which ContextEngine to use based on plugin slot configuration.
 *
 * Resolution order:
 *   1. `config.plugins.slots.contextEngine` (explicit slot override)
 *   2. Default slot value ("legacy")
 *
 * Throws if the resolved engine id has no registered factory.
 */
export async function resolveContextEngine(config?: OpenClawConfig): Promise<ContextEngine> {
  const slotValue = config?.plugins?.slots?.contextEngine;
  const engineId =
    typeof slotValue === "string" && slotValue.trim()
      ? slotValue.trim()
      : defaultSlotIdForKey("contextEngine");

  const entry = getContextEngineRegistryState().engines.get(engineId);
  if (!entry) {
    throw new Error(
      `Context engine "${engineId}" is not registered. ` +
        `Available engines: ${listContextEngineIds().join(", ") || "(none)"}`,
    );
  }

  return wrapContextEngineWithSessionKeyCompat(await entry.factory());
}
