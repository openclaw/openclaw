import {
  mergeCombinedSessionStore,
  prepareCombinedSessionStore,
  type GatewaySessionStoreOptions,
} from "../../config/sessions/combined-store-gateway.js";
import type { withIncognitoSessionStoreEntries } from "../../config/sessions/session-incognito-binding.js";
import { loadCombinedSessionStoreForGatewayCore } from "../session-utils.js";

export type IncognitoStores = Parameters<Parameters<typeof withIncognitoSessionStoreEntries>[0]>[0];

export function loadProjectSessionStore(
  cfg: Parameters<typeof loadCombinedSessionStoreForGatewayCore>[0],
  options: GatewaySessionStoreOptions & {
    loadEntries: NonNullable<GatewaySessionStoreOptions["loadEntries"]>;
  },
  incognitoStores?: IncognitoStores,
) {
  if (!incognitoStores) {
    return loadCombinedSessionStoreForGatewayCore(cfg, options);
  }
  const prepared = prepareCombinedSessionStore(cfg, { ...options, includeIncognito: false });
  prepared.targets = { ...prepared.targets, incognitoTargets: incognitoStores };
  return mergeCombinedSessionStore(
    cfg,
    options,
    prepared,
    (target) => options.loadEntries(target, prepared.projection),
    (target) => incognitoStores.find((store) => store.storePath === target.storePath)!.entries,
  );
}
