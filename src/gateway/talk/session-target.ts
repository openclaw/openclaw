import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { resolveGatewaySessionStoreTargetWithStore } from "../session-utils-store-lookup.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

export function requirePreparedTalkSessionTarget(
  target: PreparedTalkSessionTarget | undefined,
): PreparedTalkSessionTarget {
  if (!target) {
    throw new Error("Talk session target was not prepared by the Gateway");
  }
  return target;
}

/** Resolve Talk ownership before aliases collapse, then retain the exact storage target. */
export async function prepareTalkSessionTarget(
  cfg: OpenClawConfig,
  requestedSessionKey?: string,
): Promise<PreparedTalkSessionTarget> {
  const requestedKey = normalizeOptionalString(requestedSessionKey);
  const owner = resolveTalkSessionAgentId(cfg, requestedKey ?? "main");
  const sessionKey = requestedKey ?? resolveAgentMainSessionKey({ cfg, agentId: owner });
  const { agentId, canonicalKey, storePath } = await resolveTalkSessionStorageTarget(
    cfg,
    sessionKey,
    owner,
  );
  return Object.freeze({ agentId, sessionKey, canonicalKey, storePath });
}

/** Final effect checks retain exact storage authority when no prepared target is supplied. */
export function prepareTalkSessionTargetForEffect(
  cfg: OpenClawConfig,
  requestedSessionKey?: string,
): PreparedTalkSessionTarget {
  const requestedKey = normalizeOptionalString(requestedSessionKey);
  const owner = resolveTalkSessionAgentId(cfg, requestedKey ?? "main");
  const sessionKey = requestedKey ?? resolveAgentMainSessionKey({ cfg, agentId: owner });
  const { agentId, canonicalKey } = resolveSessionStoreIdentity({
    cfg,
    sessionKey,
    agentId: resolveConfiguredAgentId(cfg, owner),
  });
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg,
    key: canonicalKey,
    agentId,
    readOnly: true,
    exactRead: true,
  });
  return Object.freeze({ agentId, sessionKey, canonicalKey, storePath: target.storePath });
}

/** Revalidate a retained owner without consulting the current ambient Talk default. */
export function assertTalkSessionStorageTarget(
  cfg: OpenClawConfig,
  target: PreparedTalkSessionTarget,
): void {
  const current = resolveSessionStoreIdentity({
    cfg,
    sessionKey: target.canonicalKey,
    agentId: resolveConfiguredAgentId(cfg, target.agentId),
  });
  if (current.agentId !== target.agentId || current.canonicalKey !== target.canonicalKey) {
    throw new Error("Talk session storage target changed; retry the request");
  }
}

async function resolveTalkSessionStorageTarget(
  cfg: OpenClawConfig,
  sessionKey: string,
  owner: string,
) {
  const { agentId, canonicalKey } = resolveSessionStoreIdentity({
    cfg,
    sessionKey,
    agentId: resolveConfiguredAgentId(cfg, owner),
  });
  const target = await resolveGatewaySessionStoreTargetInWorker({
    cfg,
    key: canonicalKey,
    agentId,
  });
  return { agentId, canonicalKey, storePath: target.storePath };
}
