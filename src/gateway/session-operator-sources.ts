import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import type { OperatorRunRecoverySnapshot } from "./operator-run-recovery-source.codec.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

/** People whose latest authenticated source one session retains. */
const MAX_SESSION_OPERATOR_SOURCES = 8;
const MAX_SESSION_OPERATOR_SOURCE_BYTES = 16_384;

type SessionTarget = { agentId: string; sessionKey: string; storePath?: string };

/**
 * The bounded authenticated source an admitted person's turn may later be restored from.
 * Returns undefined for sources that cannot be revalidated (channel, synthetic, or system callers).
 */
function readRecordableSource(
  authority: AdmittedRunOperatorAuthority | undefined,
): OperatorRunRecoverySnapshot | undefined {
  const snapshot = authority?.recoverySnapshot;
  // The Gateway owner profile always resolves its own authority; it needs no recorded source.
  if (
    !authority ||
    !snapshot ||
    snapshot.profileId !== authority.profileId ||
    authority.profileId === GATEWAY_OWNER_PROFILE_ID
  ) {
    return undefined;
  }
  const source = {
    ...snapshot,
    scopes: intersectOperatorScopes(snapshot.scopes, authority.scopes),
  };
  return Buffer.byteLength(JSON.stringify(source), "utf8") <= MAX_SESSION_OPERATOR_SOURCE_BYTES
    ? source
    : undefined;
}

// Most recent source last; the oldest person is evicted beyond the bound.
function nextOperatorSources(
  current: InternalSessionEntry["operatorSources"],
  source: OperatorRunRecoverySnapshot,
): InternalSessionEntry["operatorSources"] {
  const next = Object.fromEntries(
    Object.entries(current ?? {}).filter(([profileId]) => profileId !== source.profileId),
  );
  next[source.profileId] = source;
  const keys = Object.keys(next);
  for (const profileId of keys.slice(0, Math.max(0, keys.length - MAX_SESSION_OPERATOR_SOURCES))) {
    delete next[profileId];
  }
  return next;
}

/**
 * Retain the authenticated source of a person's admitted turn on its session so later
 * session-principal work (restart resume, restart-captured input, system turns) can restore
 * exactly that source's current authority on Gateways where a profile carries none of its own.
 * Writes only when the source changed. Recording is best effort and never fails the turn.
 */
export async function recordSessionOperatorSource(
  params: SessionTarget & {
    storePath: string;
    authority: AdmittedRunOperatorAuthority | undefined;
    log: { warn: (message: string) => void };
  },
): Promise<void> {
  const source = readRecordableSource(params.authority);
  if (!source) {
    return;
  }
  try {
    const existing = await readSessionEntryReadOnlyInWorker(params);
    const stored = existing?.operatorSources?.[source.profileId];
    if (!existing || JSON.stringify(stored) === JSON.stringify(source)) {
      return;
    }
    await applySessionEntryReplacements({
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKeys: [params.sessionKey],
      update: (entries) => {
        const entry = entries.find((row) => row.sessionKey === params.sessionKey)?.entry;
        if (!entry) {
          return { result: undefined };
        }
        return {
          result: undefined,
          replacements: [
            {
              sessionKey: params.sessionKey,
              entry: {
                ...entry,
                operatorSources: nextOperatorSources(entry.operatorSources, source),
              },
            },
          ],
        };
      },
    });
  } catch (error) {
    params.log.warn(
      `Could not record operator source for ${params.sessionKey}; session-principal work after restart may need a new message: ${String(error)}`,
    );
  }
}

/**
 * Restore a person's recorded source for this session through the shared operator-source owner,
 * which rechecks device pairing, auth method, shared-secret generation, profile identity and role
 * policy on every use. Returns undefined when the session retains no source for the person.
 */
export async function restoreSessionOperatorSource(
  params: SessionTarget & {
    context: GatewayRequestContext;
    profileId: string;
    assertCurrent: () => void;
  },
): Promise<Awaited<ReturnType<typeof restoreGatewayQueuedOperatorRecovery>> | undefined> {
  const entry = await readSessionEntryReadOnlyInWorker(params, params.assertCurrent);
  const snapshot = entry?.operatorSources?.[params.profileId];
  if (!snapshot || snapshot.profileId !== params.profileId) {
    return undefined;
  }
  return restoreGatewayQueuedOperatorRecovery({
    source: { kind: "gateway", snapshot },
    context: params.context,
    assertCurrent: params.assertCurrent,
  });
}
