import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OperatorRunRecoverySnapshot } from "./operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

const MAX_SESSION_OPERATOR_SOURCES = 8;
const MAX_SESSION_OPERATOR_SOURCE_BYTES = 16_384;
type SessionTarget = { agentId: string; sessionKey: string; storePath?: string };

function nextOperatorSources(
  current: InternalSessionEntry["operatorSources"],
  source: OperatorRunRecoverySnapshot,
): NonNullable<InternalSessionEntry["operatorSources"]> {
  const next = Object.fromEntries(
    Object.entries(current ?? {}).filter(([profileId]) => profileId !== source.profileId),
  );
  next[source.profileId] = source;
  for (const profileId of Object.keys(next).slice(0, -MAX_SESSION_OPERATOR_SOURCES)) {
    delete next[profileId];
  }
  return next;
}

/** Record bounded source evidence, not a grant. Accepted input remains usable if recording fails. */
export async function recordSessionOperatorSource(
  params: SessionTarget & {
    storePath: string;
    authority: AdmittedRunOperatorAuthority | undefined;
    assertCurrent?: () => void;
    log: { warn: (message: string) => void };
  },
): Promise<void> {
  if (!params.authority || params.authority.profileId === GATEWAY_OWNER_PROFILE_ID) {
    return;
  }
  const authority = params.authority;
  try {
    // The existing capture owner validates live authority and narrows the original scopes.
    const captured = captureQueuedOperatorRecoverySource(params.authority);
    if (captured?.kind !== "gateway") {
      return;
    }
    const source = captured.snapshot;
    if (
      source.profileId !== params.authority.profileId ||
      Buffer.byteLength(JSON.stringify(source), "utf8") > MAX_SESSION_OPERATOR_SOURCE_BYTES
    ) {
      return;
    }
    await applySessionEntryReplacements({
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKeys: [params.sessionKey],
      assertCommitAllowed: () => {
        authority.assertCurrent();
        params.assertCurrent?.();
      },
      update: (entries) => {
        const entry = entries.find((row) => row.sessionKey === params.sessionKey)?.entry;
        if (
          !entry ||
          JSON.stringify(entry.operatorSources?.[source.profileId]) === JSON.stringify(source)
        ) {
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
      "Could not record operator source for " +
        params.sessionKey +
        "; restart may require a new message: " +
        String(error),
    );
  }
}

/** Restore only through the current device, auth, profile, role, and model-policy owner. */
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
