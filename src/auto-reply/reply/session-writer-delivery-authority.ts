import { getOwedHarnessCompletionTask } from "../../agents/agent-harness-completion-recovery.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import { logVerbose } from "../../globals.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
  type SessionWriterDeliveryAuthority,
} from "../reply-payload.js";

/** Capture before preparation yields; ended actors never enter durable discovery. */
function captureSessionWriterDeliveryRead(
  target: Pick<SessionWriterDeliveryAuthority, "agentId" | "sessionKey" | "storePath">,
): SessionWriterDeliveryAuthority["readCurrentSession"] {
  const memory = captureSessionEntryMetadataRead(target, () => {});
  return memory ? () => memory.readCurrent() : undefined;
}

class SessionWriterDeliveryRevokedError extends PlatformMessageNotDispatchedError {
  constructor() {
    super("Session writer changed before final reply delivery", {
      cause: undefined,
      retryable: false,
    });
    this.name = "SessionWriterDeliveryRevokedError";
  }
}

function isEntryAuthorized(
  authority: SessionWriterDeliveryAuthority,
  current: ReturnType<NonNullable<SessionWriterDeliveryAuthority["readCurrentSession"]>>,
): boolean {
  if (
    !current ||
    current.sessionId !== authority.expectedSessionId ||
    (authority.expectedLifecycleRevision !== undefined &&
      current.lifecycleRevision !== authority.expectedLifecycleRevision) ||
    (authority.expectedWriterRunId !== undefined &&
      current.activeWriterRunId !== authority.expectedWriterRunId)
  ) {
    return false;
  }
  const claim = authority.harnessCompletion;
  if (
    claim &&
    (claim.requesterSessionKey !== authority.sessionKey ||
      (authority.agentId !== undefined && claim.requesterAgentId !== authority.agentId))
  ) {
    return false;
  }
  try {
    // A queued final owns transport custody after execution cleanup. Keep the
    // exact task/outcome and session fence, not the now-retired input claim.
    return !claim || Boolean(getOwedHarnessCompletionTask(claim, current));
  } catch {
    return false;
  }
}

/** One worker preparation per delivery custody; write receipts keep its final check current. */
export async function prepareSessionWriterDeliveryAuthority(
  authority: SessionWriterDeliveryAuthority | undefined,
  fallbackStorePath?: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ authority: SessionWriterDeliveryAuthority | undefined; release: () => void }> {
  if (!authority || authority.readCurrentSession) {
    return { authority, release() {} };
  }
  const target = {
    agentId: authority.agentId,
    sessionKey: authority.sessionKey,
    storePath: authority.storePath ?? fallbackStorePath,
    projection: "list" as const,
    env,
  };
  const readMemory = captureSessionWriterDeliveryRead(target);
  if (readMemory) {
    return { authority: { ...authority, readCurrentSession: readMemory }, release() {} };
  }
  let release = () => {};
  try {
    return await withSessionEntryReadOnlyInWorker(
      target,
      () => {},
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        const entry = read.value;
        const source = owner.source;
        if (!source) {
          return {
            authority: { ...authority, readCurrentSession: () => undefined },
            release() {},
          };
        }
        const retained = retainPreparedSessionEntryPredicate({
          databaseIdentity: `file:${source.databaseIdentity}`,
          sessionKey: resolveSqliteSessionKey(authority.sessionKey, source.agentId),
          entry,
          matches: (_before, after) => isEntryAuthorized(authority, after),
        });
        release = retained.release;
        return {
          authority: {
            ...authority,
            readCurrentSession: () => (retained.isCurrent() ? entry : undefined),
          },
          release: retained.release,
        };
      },
    );
  } catch (error) {
    release();
    throw error;
  }
}

function isAuthorityCurrent(authority: SessionWriterDeliveryAuthority): boolean {
  return isEntryAuthorized(authority, authority.readCurrentSession?.());
}

/** A dispatcher's payload copies share one retained read until that dispatcher settles. */
export function createSessionWriterDeliveryPreparation(params: {
  storePath: string | undefined;
  retain: (release: () => void) => void;
}) {
  const prepared = new WeakMap<
    SessionWriterDeliveryAuthority,
    ReturnType<typeof prepareSessionWriterDeliveryAuthority>
  >();
  return async (payload: ReplyPayload) => {
    const authority = getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority;
    if (!authority) {
      return;
    }
    if (!authority.readCurrentSession) {
      let current = prepared.get(authority);
      if (!current) {
        current = prepareSessionWriterDeliveryAuthority(authority, params.storePath).then(
          (value) => {
            params.retain(value.release);
            return value;
          },
        );
        prepared.set(authority, current);
      }
      const value = await current;
      setReplyPayloadMetadata(payload, { sessionWriterDeliveryAuthority: value.authority });
    }
  };
}

/** Revalidates a settled final payload against the latest committed session writer. */
export function isDispatchFinalReplySessionWriterAuthorized(
  payload: ReplyPayload,
  fallbackSessionKey?: string,
): boolean {
  const authority = getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority;
  if (!authority) {
    return true;
  }
  const authorized = isAuthorityCurrent(authority);
  if (!authorized) {
    logVerbose(
      `final reply skipped after session writer replacement (session=${fallbackSessionKey ?? authority.sessionKey})`,
    );
  }
  return authorized;
}

/** Fails closed at the provider's last pre-I/O boundary when writer ownership changed. */
export function assertSessionWriterDeliveryAuthorized(
  authority: SessionWriterDeliveryAuthority | undefined,
): void {
  if (authority && !isAuthorityCurrent(authority)) {
    throw new SessionWriterDeliveryRevokedError();
  }
}
