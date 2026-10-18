import type { ReactiveController, ReactiveControllerHost } from "lit";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { SessionListSnapshot } from "../lib/sessions/session-capability.ts";
import type { SessionDataController } from "./session-data-controller.ts";

export type PersonActivityData = Readonly<
  Pick<SessionDataController, "sessionsResult" | "presencePayload">
>;

type PersonPresenceData = Pick<PersonActivityData, "presencePayload">;
type PersonActivitySource = { data?: PersonPresenceData; listeners: Set<() => void> };
// Presence keeps its existing publisher; session membership belongs to the
// managed roster query below, never the sidebar's presentation filters.
const sources = new WeakMap<ApplicationContext, PersonActivitySource>();
function sourceFor(context: ApplicationContext): PersonActivitySource {
  let source = sources.get(context);
  if (!source) {
    source = { listeners: new Set() };
    sources.set(context, source);
  }
  return source;
}

/** Publishes the existing roster owner's facts after its update, without copying state. */
export class PersonActivityDataController implements ReactiveController {
  private source: PersonActivitySource | undefined;
  constructor(
    private readonly host: ReactiveControllerHost & { readonly isConnected: boolean },
    private readonly context: () => ApplicationContext | undefined,
    private readonly data: PersonPresenceData,
  ) {}

  hostUpdated() {
    if (!this.host.isConnected) {
      return;
    }
    const context = this.context();
    const source = context ? sourceFor(context) : undefined;
    if (this.source !== source) {
      this.hostDisconnected();
      this.source = source;
    }
    if (source) {
      source.data = this.data;
      for (const listener of source.listeners) {
        listener();
      }
    }
  }

  hostDisconnected() {
    if (this.source?.data === this.data) {
      this.source.data = undefined;
      for (const listener of this.source.listeners) {
        listener();
      }
    }
    this.source = undefined;
  }
}

export function observePersonActivityData(context: ApplicationContext, changed: () => void) {
  const source = sourceFor(context);
  const sessions = context.sessions;
  const scope = sessions.captureConnectionScope();
  let disposed = false;
  let ready = false;
  let snapshot: SessionListSnapshot | undefined;
  let result: PersonActivityData["sessionsResult"] = null;
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
  source.listeners.add(notify);
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
            presencePayload: source.data?.presencePayload,
            sessionsResult: result,
          }
        : undefined;
    },
    dispose: () => {
      disposed = true;
      observation?.dispose();
      source.listeners.delete(notify);
    },
  };
}
