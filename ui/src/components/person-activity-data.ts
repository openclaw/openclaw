import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import type { ApplicationContext } from "../app/context.ts";
import { readPresenceEntries } from "../app/user-profile.ts";
import type { SessionListSnapshot } from "../lib/sessions/session-capability.ts";
import type { SessionDataOwner } from "./session-data.ts";

type SessionPreview =
  | { status: "loading" | "unavailable" }
  | { status: "ready"; result: NonNullable<SessionListSnapshot["result"]> };

type PersonPresenceData = Pick<SessionDataOwner, "presencePayload">;
export type PersonActivityData = Readonly<PersonPresenceData & { sessions: SessionPreview }>;
const sources = new WeakMap<ApplicationContext, PersonPresenceData>();

/** Late-open cards read the current owner's snapshot, not the initial hello. */
export function registerPersonActivityData(context: ApplicationContext, data: PersonPresenceData) {
  sources.set(context, data);
  return () => {
    if (sources.get(context) === data) {
      sources.delete(context);
    }
  };
}

export function observePersonActivityData(context: ApplicationContext, changed: () => void) {
  const sessions = context.sessions;
  const scope = sessions.captureConnectionScope();
  let disposed = false;
  let initialReadSettled = false;
  let snapshot: SessionListSnapshot | undefined;
  let acceptedResult: SessionListSnapshot["result"] = null;
  const initialPresence = readPresenceEntries(context.gateway.snapshot.hello?.snapshot);
  const source = sources.get(context);
  let presencePayload = source
    ? source.presencePayload
    : initialPresence
      ? { presence: initialPresence }
      : undefined;
  const current = () => !disposed && scope !== null && sessions.isConnectionScopeCurrent(scope);
  const notify = () => {
    if (current()) {
      if (
        initialReadSettled &&
        snapshot?.result &&
        !snapshot.loading &&
        !snapshot.error &&
        snapshot.readSucceeded === true
      ) {
        acceptedResult = snapshot.result;
      }
      changed();
    }
  };
  const stopPresence = context.gateway.subscribeEvents((event) => {
    if (event.event === "presence" && current()) {
      const presence = readPresenceEntries(event.payload);
      presencePayload = presence ? { presence } : undefined;
      notify();
    }
  });
  const observation = scope
    ? sessions.observeList(
        {
          source: "activity",
          limit: SIDEBAR_SESSION_ROSTER_LIMIT,
          rowMode: "compact",
          includeDerivedTitles: true,
          includeLastMessage: true,
        },
        (next) => {
          snapshot = next;
          if (initialReadSettled) {
            notify();
          }
        },
      )
    : undefined;
  const settled = () => {
    initialReadSettled = true;
    notify();
  };
  // Do not freeze Recent sessions from a retained snapshot before this open's
  // access-scoped refresh completes. The managed owner also handles live events.
  // A resolved refresh may only report temporary Gateway unavailability.
  // Admit membership from the owner's successful-read receipt, not settlement.
  void observation?.refresh().then(settled, () => {
    snapshot = undefined;
    settled();
  });
  return {
    get data(): PersonActivityData | undefined {
      if (!current()) {
        return undefined;
      }
      // Keep accepted links during refresh. No accepted result is not an empty result.
      return {
        presencePayload,
        sessions: acceptedResult
          ? { status: "ready", result: acceptedResult }
          : {
              status:
                !initialReadSettled || snapshot?.loading || snapshot?.startupPending
                  ? "loading"
                  : "unavailable",
            },
      };
    },
    dispose: () => {
      disposed = true;
      observation?.dispose();
      stopPresence();
    },
  };
}
