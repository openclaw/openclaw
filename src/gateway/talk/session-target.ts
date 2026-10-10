import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { resolveGatewaySessionStoreTargetWithStore } from "../session-utils-store-lookup.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

export function requirePreparedTalkSessionTarget(
  target: PreparedTalkSessionTarget | undefined,
): PreparedTalkSessionTarget {
  if (!target) {
    throw new Error("Talk session target was not prepared by the Gateway");
  }
  target.assertCurrent?.();
  return target;
}

/** Resolve Talk ownership before aliases collapse, then retain the exact storage target. */
export function prepareTalkSessionTarget(
  cfg: OpenClawConfig,
  requestedSessionKey?: string,
): PreparedTalkSessionTarget {
  const requestedKey = normalizeOptionalString(requestedSessionKey);
  const owner = resolveTalkSessionAgentId(cfg, requestedKey ?? "main");
  const sessionKey = requestedKey ?? resolveAgentMainSessionKey({ cfg, agentId: owner });
  const storage = resolveTalkSessionStorageTarget(cfg, sessionKey, owner);
  return Object.freeze({ ...storage, sessionKey });
}

/** Revalidate a retained owner without consulting the current ambient Talk default. */
export function assertTalkSessionStorageTarget(
  cfg: OpenClawConfig,
  target: PreparedTalkSessionTarget,
): void {
  target.assertCurrent?.();
  if (target.withSource) {
    const current = resolveSessionStoreIdentity({
      cfg,
      sessionKey: target.canonicalKey,
      agentId: resolveConfiguredAgentId(cfg, target.agentId),
    });
    if (current.agentId !== target.agentId || current.canonicalKey !== target.canonicalKey) {
      throw new Error("Talk session storage target changed; retry the request");
    }
    return;
  }
  const current = resolveTalkSessionStorageTarget(cfg, target.canonicalKey, target.agentId);
  if (
    current.agentId !== target.agentId ||
    current.canonicalKey !== target.canonicalKey ||
    current.storePath !== target.storePath
  ) {
    throw new Error("Talk session storage target changed; retry the request");
  }
}

function resolveTalkSessionStorageTarget(cfg: OpenClawConfig, sessionKey: string, owner: string) {
  const { agentId, canonicalKey } = resolveSessionStoreIdentity({
    cfg,
    sessionKey,
    agentId: resolveConfiguredAgentId(cfg, owner),
  });
  const incognito = captureIncognitoSessionSource({ agentId, sessionKey: canonicalKey });
  if (incognito) {
    return {
      agentId,
      canonicalKey,
      storePath: "kind" in incognito ? incognito.path : incognito.actor.path,
      assertCurrent() {
        incognito.admissionSignal?.throwIfAborted();
        if ("kind" in incognito) {
          incognito.assertCurrent();
        } else {
          incognito.actor.assertReadable();
        }
      },
      withSource<T>(consume: () => Promise<T>): Promise<T> {
        incognito.admissionSignal?.throwIfAborted();
        if ("kind" in incognito) {
          incognito.assertCurrent();
          return withIncognitoSessionBinding(
            {
              kind: "absent",
              agentId: incognito.agentId,
              env: incognito.env,
              authority: { assertCurrent: incognito.assertCurrent },
              admissionSignal: incognito.admissionSignal,
            },
            consume,
          );
        }
        return incognito.actor.sessions.withSharedState(() =>
          withIncognitoSessionBinding(incognito, consume),
        );
      },
    };
  }
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg,
    key: canonicalKey,
    agentId,
    readOnly: true,
    exactRead: true,
  });
  return { agentId, canonicalKey, storePath: target.storePath };
}
