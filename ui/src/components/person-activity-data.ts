import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import type { ApplicationContext } from "../app/context.ts";
import { readPresenceEntries } from "../app/user-profile.ts";
import type { SessionListSnapshot } from "../lib/sessions/session-capability.ts";
import type { SessionDataController } from "./session-data-controller.ts";

export type PersonActivityData = Readonly<
  Pick<SessionDataController, "sessionsResult" | "presencePayload">
>;

type PersonPresenceData = Pick<PersonActivityData, "presencePayload">;
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
  let ready = false;
  let snapshot: SessionListSnapshot | undefined;
  let result: PersonActivityData["sessionsResult"] = null;
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
        ready &&
        snapshot &&
        !snapshot.loading &&
        !snapshot.error &&
        snapshot.readSucceeded === true
      ) {
        result = snapshot.result;
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
          if (ready) {
            notify();
          }
        },
      )
    : undefined;
  const settled = () => {
    ready = true;
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
      return current()
        ? {
            presencePayload,
            sessionsResult: result,
          }
        : undefined;
    },
    dispose: () => {
      disposed = true;
      observation?.dispose();
      stopPresence();
    },
  };
}
