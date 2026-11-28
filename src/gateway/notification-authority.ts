// Shared per-recipient authority for notification destinations. Every destination
// rechecks each recipient here, against current session facts, before it sends.
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeWebPushDisplayLabel } from "../infra/push-web-preferences.js";
import type { NotificationIntent } from "./notification-intent.js";
import type { GatewayClient } from "./server-methods/types.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { PreparedSessionMutationFacts } from "./session-sharing-policy.js";
import {
  prepareSessionMutationFacts,
  type SessionFactsRead,
} from "./session-sharing-preparation.js";
import { prepareProjectedSessionSharing } from "./session-sharing-read.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

/** Session facts read once per authority snapshot and shared by every recipient in it. */
export type NotificationAuthoritySnapshot = {
  cfg: OpenClawConfig;
  sessions: Map<string, PreparedSessionMutationFacts>;
};

export type NotificationSessionFacts = {
  /** Reads current facts for one synchronous authority snapshot. */
  read: (cfg: OpenClawConfig) => Map<string, PreparedSessionMutationFacts>;
  /**
   * Joins the producer's publication and in-flight session writes. Destinations await it
   * immediately before their final synchronous check; undefined when neither applies.
   */
  publication: (prepare?: () => Promise<void>) => (() => Promise<void>) | undefined;
};

/** Holds session facts for the intent's sessions until `run` settles. */
export async function withNotificationSessionFacts<T>(
  params: {
    getRuntimeConfig: () => OpenClawConfig;
    sessionKeys?: readonly string[];
    agentId?: string;
  },
  run: (facts: NotificationSessionFacts) => Promise<T>,
): Promise<T> {
  const sessions = new Map<string, SessionFactsRead<PreparedSessionMutationFacts>>();
  try {
    for (const sessionKey of new Set(params.sessionKeys)) {
      const cfg = params.getRuntimeConfig();
      const { agentId } = resolveSessionStoreIdentity({
        cfg,
        sessionKey,
        agentId: params.agentId,
      });
      sessions.set(
        sessionKey,
        await prepareSessionMutationFacts({ cfg, sessionKey, agentId, allowMissing: true }),
      );
    }
    return await run({
      read: (cfg) => new Map([...sessions].map(([key, facts]) => [key, facts.readCurrent(cfg)])),
      publication: (prepare) =>
        sessions.size > 0
          ? async () => {
              if (prepare) {
                await prepare();
              }
              // Session writes can begin while recipients load; join their publication before
              // the final synchronous access check, without retaining facts through provider I/O.
              await Promise.all(
                [...sessions.values()].flatMap((facts) => facts.prepareRead() ?? []),
              );
            }
          : prepare,
    });
  } finally {
    for (const facts of sessions.values()) {
      facts.release();
    }
  }
}

/** Session sharing access for one recipient, from one authority snapshot. */
export function notificationSessionAccess(
  snapshot: NotificationAuthoritySnapshot,
  client: GatewayClient,
) {
  return {
    sharing: prepareProjectedSessionSharing({
      cfg: snapshot.cfg,
      client,
      isMember: (target, identity) =>
        [...snapshot.sessions.values()].some(
          (facts) => facts.target === target && facts.membership.has(identity),
        ),
    }),
    target: (sessionKey: string) => snapshot.sessions.get(sessionKey)?.target ?? null,
  };
}

/**
 * The per-recipient recheck. `client` must carry the recipient's current authority,
 * resolved with the intent's required and visibility scopes.
 */
export function canNotificationRecipientReceive(
  intent: NotificationIntent,
  snapshot: NotificationAuthoritySnapshot,
  client: GatewayClient,
): boolean {
  return intent.canReceive({
    cfg: snapshot.cfg,
    client,
    sessionAccess: () => notificationSessionAccess(snapshot, client),
  });
}

/** The targeted recipient's current profile id; undefined once that profile no longer resolves. */
export function currentNotificationRecipientProfileId(
  intent: NotificationIntent,
  profiles:
    | { readCurrentIdentity: (profileId: string) => { profileId: string } | null | undefined }
    | undefined,
): string | undefined {
  return intent.recipient
    ? profiles?.readCurrentIdentity(intent.recipient.profileId)?.profileId
    : undefined;
}

/** Control UI path without a leading slash; undefined when a targeted intent has no session to open. */
export function resolveNotificationPath(
  intent: NotificationIntent,
  cfg: OpenClawConfig,
): string | undefined {
  if (intent.path) {
    return intent.path;
  }
  const sessionKey = intent.sessionKeys[0];
  const sessionPath = sessionKey
    ? buildControlUiSessionPath({
        namespace: "chat",
        sessionKey,
        fallbackAgentId: intent.agentId,
        mainKey: cfg.session?.mainKey,
        exactKey: true,
      })
    : undefined;
  if (intent.recipient && !sessionPath) {
    return undefined;
  }
  return sessionPath?.slice(1) ?? "sessions";
}

/** The authorized session's explicit label for `labelsSession` intents about exactly one session. */
export function readNotificationSessionLabel(
  intent: NotificationIntent,
  snapshot: NotificationAuthoritySnapshot,
  projection: Pick<SessionRowProjection, "readCapabilityEntry"> | undefined,
): string | undefined {
  const sessionKey = intent.sessionKeys.length === 1 ? intent.sessionKeys[0] : undefined;
  if (!intent.labelsSession || !sessionKey) {
    return undefined;
  }
  // Read resident metadata only after authorization; never infer a title from content.
  const authorized = snapshot.sessions.get(sessionKey)?.target;
  const entry = authorized
    ? projection?.readCapabilityEntry({
        agentId: authorized.agentId,
        storePath: authorized.storePath,
        key: authorized.canonicalKey,
      })?.entry
    : undefined;
  return normalizeWebPushDisplayLabel(
    entry?.sessionId === authorized?.entry.sessionId ? entry?.label : undefined,
  );
}
