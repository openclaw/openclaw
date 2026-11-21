import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { ApplicationContext } from "../app/context-types.ts";
import type { SessionListScope, SessionListSnapshot } from "../lib/sessions/session-capability.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

// Keep existing browser-origin dismissals across invitation design changes.
export const COMMUNITY_INVITE_KEY = "openclaw:control-ui:community-invite:v2";

/** Distinct conversations the person must have prompted before the invitation can appear. */
export const COMMUNITY_INVITE_SESSION_THRESHOLD = 3;

// The Gateway counts sessions with the viewer's recorded prompts. Ownership, imports,
// activity timestamps, and other people's prompts are not participation; automation,
// probes, subagents, and dock conversations are excluded before counting.
const SESSION_USE_QUERY = {
  source: "sidebar",
  promptedByMe: true,
  archivedFilter: "all",
  limit: 1,
  rowMode: "compact",
  includeDerivedTitles: false,
  includeLastMessage: false,
  includeGlobal: false,
  includeUnknown: false,
  excludeSubagents: true,
  excludeCron: true,
  excludeSystem: true,
  excludeDock: true,
} as const satisfies SessionListScope;

// A failed save must still dismiss across sidebar remounts in this page.
let unpersistedDismissal = false;

export function isCommunityInviteDismissed(): boolean {
  if (unpersistedDismissal) {
    return true;
  }
  try {
    // Any stored marker, including malformed content, suppresses the invite.
    return getSafeLocalStorage()?.getItem(COMMUNITY_INVITE_KEY) !== null;
  } catch {
    return true;
  }
}

export function dismissCommunityInvite(): Result<void, "storage-unavailable"> {
  unpersistedDismissal = true;
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return err("storage-unavailable");
    }
    storage.setItem(COMMUNITY_INVITE_KEY, JSON.stringify({ dismissedAtMs: Date.now() }));
    unpersistedDismissal = false;
    return ok(undefined);
  } catch {
    return err("storage-unavailable");
  }
}

/**
 * Calls `reached` once, after a settled Gateway read for the current connection counts
 * enough prompted sessions. Missing, failed, or retained reads keep the invitation hidden.
 */
export function observeCommunityInviteSessionUse(
  context: Pick<ApplicationContext, "gateway" | "sessions" | "connectionBootstrap">,
  reached: () => void,
): () => void {
  const sessions = context.sessions;
  let stopGateway: (() => void) | undefined;
  let current:
    | {
        scope: NonNullable<ReturnType<typeof sessions.captureConnectionScope>>;
        observation: ReturnType<typeof sessions.observeList>;
      }
    | undefined;
  const stop = () => {
    stopGateway?.();
    stopGateway = undefined;
    current?.observation.dispose();
    current = undefined;
  };
  const start = () => {
    if (current && sessions.isConnectionScopeCurrent(current.scope)) {
      return;
    }
    current?.observation.dispose();
    current = undefined;
    const scope = sessions.captureConnectionScope();
    if (!scope) {
      return;
    }
    let accepted = false;
    let latest: SessionListSnapshot | undefined;
    const check = () => {
      if (
        accepted &&
        latest?.readSucceeded === true &&
        !latest.loading &&
        !latest.error &&
        (latest.pagination?.totalCount ?? 0) >= COMMUNITY_INVITE_SESSION_THRESHOLD &&
        sessions.isConnectionScopeCurrent(scope)
      ) {
        stop();
        reached();
      }
    };
    const observation = sessions.observeList(SESSION_USE_QUERY, (snapshot) => {
      latest = snapshot;
      check();
    });
    const entry = (current = { scope, observation });
    // Like other sidebar hydration, wait for selected-chat startup. A retained snapshot
    // from another viewer or page proves nothing until this connection's read settles.
    void context.connectionBootstrap.run(
      observation,
      async () => {
        if (current === entry) {
          await observation.refresh().catch(() => undefined);
          accepted = true;
          check();
        }
      },
      { background: true },
    );
  };
  stopGateway = context.gateway.subscribe(start);
  start();
  return stop;
}
