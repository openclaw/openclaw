import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../utils.js";
import { getConfigValueAtPath, unsetConfigValueAtPath } from "./config-paths.js";
import {
  isPerAgentSessionStoreConfig,
  isSameSessionStoreConfig,
} from "./sessions/session-store-config.js";
import type { OpenClawConfig } from "./types.js";

const SESSION_STORE_OWNER_PATH = ["agents", "defaults", "sessionStore", "agentId"] as const;
const SESSION_STORE_CONFIG_PATH = SESSION_STORE_OWNER_PATH.slice(0, -1);

export function prepareSessionStoreOwnershipForWrite(params: {
  currentConfig: OpenClawConfig;
  currentStore: string | undefined;
  targetConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  explicitSetPaths?: readonly (readonly string[])[];
  explicitSetValueSource?: OpenClawConfig;
}): { config: OpenClawConfig; sameFixedSessionStore: boolean; ownershipPaths: string[][] } {
  const sameSessionStore = isSameSessionStoreConfig(
    params.currentStore,
    params.targetConfig.session?.store,
    params.env,
  );
  const sameFixedSessionStore =
    sameSessionStore && !isPerAgentSessionStoreConfig(params.currentStore);
  const previousOwner = params.currentConfig.agents?.defaults?.sessionStore?.agentId;
  const explicitSessionStore = getConfigValueAtPath(
    (params.explicitSetValueSource ?? params.targetConfig) as Record<string, unknown>,
    SESSION_STORE_CONFIG_PATH,
  );
  const suppliesDestinationOwner = Boolean(
    isRecord(explicitSessionStore) &&
    typeof explicitSessionStore.agentId === "string" &&
    params.explicitSetPaths?.some(
      (entry) =>
        isDeepStrictEqual(entry, SESSION_STORE_CONFIG_PATH) ||
        isDeepStrictEqual(entry, SESSION_STORE_OWNER_PATH),
    ),
  );
  // Per-agent stores also retain this owner for retired-main migration. Clear a copied owner
  // only on a store transition; an owner-specific authored path establishes the new owner.
  if (sameSessionStore || !previousOwner || suppliesDestinationOwner) {
    return { config: params.targetConfig, sameFixedSessionStore, ownershipPaths: [] };
  }
  const agents = structuredClone(params.targetConfig.agents ?? {});
  unsetConfigValueAtPath(agents as Record<string, unknown>, SESSION_STORE_OWNER_PATH.slice(1));
  return {
    config: { ...params.targetConfig, agents },
    sameFixedSessionStore,
    ownershipPaths: [[...SESSION_STORE_OWNER_PATH]],
  };
}
