import type { ModelRef } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { parseModelRef, resolveConfiguredModelRef } from "../agents/model-selection.js";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";

/**
 * Query the current model for a given session key.
 * Returns the effective model being used by the session.
 */
export async function getCurrentSessionModel(sessionKey: string): Promise<ModelRef | null> {
  try {
    // First try to get session info from the gateway
    const sessionInfo = await getSessionInfo(sessionKey);
    if (sessionInfo?.effectiveModel) {
      return sessionInfo.effectiveModel;
    }

    // Fallback: try to parse from stored session data
    const storedModel = await getStoredSessionModel(sessionKey);
    if (storedModel) {
      return storedModel;
    }

    // Last resort: return default configured model
    const cfg = loadConfig();
    return resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
  } catch (error) {
    console.warn(
      `[getCurrentSessionModel] Failed to query model for session ${sessionKey}:`,
      error,
    );
    return null;
  }
}

/**
 * Get session information from the gateway.
 * This includes the currently active model configuration.
 */
async function getSessionInfo(sessionKey: string): Promise<{
  effectiveModel?: ModelRef;
  sessionEntry?: SessionEntry;
} | null> {
  try {
    // Try to get session status from gateway
    const response = await callGateway<{
      session?: {
        key: string;
        model?: string;
        providerOverride?: string;
        modelOverride?: string;
      };
    }>({
      method: "sessions.get",
      params: { key: sessionKey },
      timeoutMs: 5_000,
    });

    if (!response?.session) {
      return null;
    }

    const session = response.session;

    // Try to extract model from response
    let effectiveModel: ModelRef | null = null;

    // Check for explicit model string first
    if (session.model) {
      const parsed = parseModelRef(session.model, DEFAULT_PROVIDER);
      if (parsed) {
        effectiveModel = parsed;
      }
    }

    // Check for provider/model overrides only if session.model didn't already
    // resolve an explicit model. session.model takes precedence over overrides.
    if (!effectiveModel && session.providerOverride && session.modelOverride) {
      effectiveModel = {
        provider: session.providerOverride,
        model: session.modelOverride,
      };
    }

    return {
      effectiveModel: effectiveModel || undefined,
    };
  } catch (error) {
    // Gateway might not support sessions.get or session might not exist
    return null;
  }
}

/**
 * Get stored session model from config/session store.
 * This is a fallback when gateway queries fail.
 */
async function getStoredSessionModel(sessionKey: string): Promise<ModelRef | null> {
  try {
    const cfg = loadConfig();

    // Try to load session from store
    const sessionStore = await loadSessionStore();
    const sessionEntry = sessionStore?.[sessionKey];

    if (!sessionEntry) {
      return null;
    }

    // Extract model from session entry
    if (sessionEntry.providerOverride && sessionEntry.modelOverride) {
      return {
        provider: sessionEntry.providerOverride,
        model: sessionEntry.modelOverride,
      };
    }

    // Fallback to default model for the session
    return resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
  } catch (error) {
    return null;
  }
}

/**
 * Load the session store from disk/config.
 *
 * TODO: Implement this function using OpenClaw's actual session persistence layer
 * (e.g. config/sessions.js or the gateway store). Until then this is a stub that
 * always returns null, which means `getStoredSessionModel` immediately falls back
 * to the configured default model. The entire stub + its callers can be removed if
 * session-store access is handled exclusively via the gateway (getSessionInfo).
 */
async function loadSessionStore(): Promise<Record<string, SessionEntry> | null> {
  return null;
}

/**
 * Extract model reference from a session entry.
 */
export function extractModelFromSessionEntry(sessionEntry: SessionEntry): ModelRef | null {
  if (sessionEntry.providerOverride && sessionEntry.modelOverride) {
    return {
      provider: sessionEntry.providerOverride,
      model: sessionEntry.modelOverride,
    };
  }
  return null;
}

/**
 * Get the effective model string for a session.
 * This is useful for debugging and logging.
 */
export async function getCurrentSessionModelString(sessionKey: string): Promise<string | null> {
  const modelRef = await getCurrentSessionModel(sessionKey);
  if (!modelRef) {
    return null;
  }
  return `${modelRef.provider}/${modelRef.model}`;
}

/**
 * Check if a session exists and is active.
 */
export async function isSessionActive(sessionKey: string): Promise<boolean> {
  try {
    const sessionInfo = await getSessionInfo(sessionKey);
    return sessionInfo !== null;
  } catch (error) {
    return false;
  }
}
