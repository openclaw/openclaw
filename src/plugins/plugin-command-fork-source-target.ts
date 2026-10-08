import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Read persistent source metadata off the Gateway thread, retaining process-held incognito reads. */
export async function loadPluginForkSourceTarget(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  assertCurrent: () => void;
}) {
  params.assertCurrent();
  const { resolveGatewaySessionStoreTargetInWorker } =
    await import("../gateway/session-utils-store-worker.js");
  const target = await resolveGatewaySessionStoreTargetInWorker({
    cfg: params.config,
    key: params.sessionKey,
    agentId: params.agentId,
    assertActive: params.assertCurrent,
  });
  params.assertCurrent();
  const [{ isInternalSessionEffectsKey }, { resolveCanonicalSessionEntryFromStoreKeys }] =
    await Promise.all([
      import("../config/sessions/internal-session-key.js"),
      import("../gateway/session-utils.js"),
    ]);
  params.assertCurrent();
  return {
    target,
    storePath: target.storePath,
    entry: isInternalSessionEffectsKey(target.canonicalKey)
      ? undefined
      : resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys),
    canonicalKey: target.canonicalKey,
    sessionStoreKey: target.canonicalKey,
  };
}
