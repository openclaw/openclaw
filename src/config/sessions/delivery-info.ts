import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "../../gateway/session-store-key.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionStore } from "./store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "./targets.js";
import { parseSessionThreadInfo } from "./thread-info.js";
export { parseSessionThreadInfo };

function hasRoutableDeliveryContext(context?: {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
}): context is {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
} {
  return Boolean(context?.channel && context?.to);
}

export function extractDeliveryInfo(
  sessionKey: string | undefined,
  options?: { cfg?: OpenClawConfig },
): {
  deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string | number }
    | undefined;
  threadId: string | undefined;
} {
  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  if (!sessionKey || !baseSessionKey) {
    return { deliveryContext: undefined, threadId };
  }

  let deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string | number }
    | undefined;
  try {
    const cfg = options?.cfg ?? getRuntimeConfig();
    const lookup = loadDeliverySessionEntry({ cfg, sessionKey, baseSessionKey });
    let entry = lookup.entry;
    let storedDeliveryContext = deliveryContextFromSession(entry);
    if (!hasRoutableDeliveryContext(storedDeliveryContext) && baseSessionKey !== sessionKey) {
      entry = lookup.baseEntry;
      storedDeliveryContext = deliveryContextFromSession(entry);
    }
    if (hasRoutableDeliveryContext(storedDeliveryContext)) {
      deliveryContext = {
        channel: storedDeliveryContext.channel,
        to: storedDeliveryContext.to,
        accountId: storedDeliveryContext.accountId,
        threadId: storedDeliveryContext.threadId,
      };
    }
  } catch {
    // ignore: best-effort
  }
  return { deliveryContext, threadId };
}

function resolveDeliveryStorePaths(cfg: OpenClawConfig, agentId: string): string[] {
  const paths = new Set<string>();
  paths.add(resolveStorePath(cfg.session?.store, { agentId }));
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    if (target.agentId === agentId) {
      paths.add(target.storePath);
    }
  }
  return [...paths];
}

function findSessionEntryInStore(
  store: ReturnType<typeof loadSessionStore>,
  keys: readonly string[],
) {
  let legacyIndex: Map<string, string> | undefined;
  for (const key of keys) {
    const direct = store[key];
    if (direct) {
      return direct;
    }
    const normalized = normalizeLowercaseStringOrEmpty(key);
    legacyIndex ??= new Map(
      Object.keys(store).map((candidate) => [
        normalizeLowercaseStringOrEmpty(candidate),
        candidate,
      ]),
    );
    const legacyKey = legacyIndex.get(normalized);
    if (legacyKey && store[legacyKey]) {
      return store[legacyKey];
    }
  }
  return undefined;
}

function loadDeliverySessionEntry(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  baseSessionKey: string;
}) {
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const canonicalBaseKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.baseSessionKey,
  });
  const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
  const sessionKeys = [params.sessionKey, canonicalKey];
  const baseKeys = [params.baseSessionKey, canonicalBaseKey];
  let fallback:
    | {
        entry: ReturnType<typeof findSessionEntryInStore>;
        baseEntry: ReturnType<typeof findSessionEntryInStore>;
      }
    | undefined;
  for (const storePath of resolveDeliveryStorePaths(params.cfg, agentId)) {
    const store = loadSessionStore(storePath);
    const entry = findSessionEntryInStore(store, sessionKeys);
    const baseEntry = findSessionEntryInStore(store, baseKeys);
    if (!entry && !baseEntry) {
      continue;
    }
    fallback ??= { entry, baseEntry };
    if (
      hasRoutableDeliveryContext(deliveryContextFromSession(entry)) ||
      hasRoutableDeliveryContext(deliveryContextFromSession(baseEntry))
    ) {
      return { entry, baseEntry };
    }
  }
  return fallback ?? { entry: undefined, baseEntry: undefined };
}
