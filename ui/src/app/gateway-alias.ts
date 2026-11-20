import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { createChangeListeners } from "../../../src/shared/listeners.js";
import { listen } from "../lib/reactive/listener.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

const STORAGE_PREFIX = "openclaw.control.gateway-alias.v1:";
const changes = createChangeListeners();
export const GATEWAY_ALIAS_MAX_LENGTH = 64;

function aliasKey(gatewayUrl: string) {
  return STORAGE_PREFIX + gatewayOriginScope(gatewayUrl);
}

function isOverLimit(alias: string): boolean {
  return alias.length > GATEWAY_ALIAS_MAX_LENGTH && [...alias].length > GATEWAY_ALIAS_MAX_LENGTH;
}

export function readGatewayAlias(gatewayUrl: string): string | undefined {
  try {
    const alias = getSafeLocalStorage()?.getItem(aliasKey(gatewayUrl))?.trim();
    return alias && !isOverLimit(alias) ? alias : undefined;
  } catch {
    return undefined;
  }
}

export function saveGatewayAlias(
  gatewayUrl: string,
  value: string,
): "too-long" | "storage-unavailable" | null {
  const alias = value.trim();
  if (isOverLimit(alias)) {
    return "too-long";
  }
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return "storage-unavailable";
    }
    const key = aliasKey(gatewayUrl);
    if (alias) {
      storage.setItem(key, alias);
    } else {
      storage.removeItem(key);
    }
  } catch {
    return "storage-unavailable";
  }
  changes.publish();
  return null;
}

export function subscribeGatewayAliases(listener: () => void): () => void {
  const stopLocal = changes.subscribe(listener);
  const stopOtherTabs = listen(window, "storage", (event) => {
    if (
      event.storageArea === getSafeLocalStorage() &&
      (event.key === null || event.key.startsWith(STORAGE_PREFIX))
    ) {
      listener();
    }
  });
  return () => {
    stopLocal();
    stopOtherTabs();
  };
}
