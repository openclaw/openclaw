import { mergeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { UpdateRestartSentinelMeta } from "./update-restart-sentinel-payload.js";
import type { UpdateRunRecord } from "./update-run-record.js";

/** Explicit routing wins; fallback belongs only to the original session owner. */
export function resolveUpdateRestartNoticeMeta(
  run: Pick<UpdateRunRecord, "origin"> | undefined,
  meta: UpdateRestartSentinelMeta,
): UpdateRestartSentinelMeta {
  const sessionKey = meta.sessionKey ?? run?.origin.sessionKey;
  const originDelivery =
    !meta.sessionKey || meta.sessionKey === run?.origin.sessionKey
      ? run?.origin.deliveryContext
      : undefined;
  const resolvedMeta = { ...meta, ...(sessionKey ? { sessionKey } : {}) };
  if (!originDelivery) {
    return resolvedMeta;
  }
  const route = mergeDeliveryContext(
    {
      ...meta.deliveryContext,
      ...(meta.threadId != null ? { threadId: meta.threadId } : {}),
    },
    originDelivery,
  );
  if (!route) {
    return resolvedMeta;
  }
  const { threadId, ...deliveryContext } = route;
  return {
    ...resolvedMeta,
    deliveryContext,
    ...(threadId != null ? { threadId: String(threadId) } : {}),
  };
}

/** Notices resume requested work; a standalone CLI run is reported by its ledger. */
export function shouldPublishUpdateRestartNotice(
  run: Pick<UpdateRunRecord, "trigger" | "origin"> | undefined,
  meta: UpdateRestartSentinelMeta,
): boolean {
  // Unknown and Gateway-origin runs retain their existing notification behavior.
  // Restored runtimes may not know how to suppress an unrequested CLI wake.
  return !(
    run?.trigger === "cli" &&
    !run.origin.sessionKey &&
    !run.origin.deliveryContext &&
    !meta.sessionKey?.trim() &&
    !meta.deliveryContext &&
    meta.threadId == null &&
    !meta.note?.trim() &&
    !meta.continuationMessage?.trim()
  );
}
