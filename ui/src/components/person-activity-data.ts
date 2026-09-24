import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../app/context.ts";
import type { SessionDataController } from "./session-data-controller.ts";

export type PersonActivityData = Readonly<
  Pick<
    SessionDataController,
    | "sessionsAgentId"
    | "sessionsResult"
    | "sessionResultsByAgent"
    | "childSessionRowsByParent"
    | "loadedChildSessionKeys"
    | "presencePayload"
  >
>;

type PersonActivitySource = { data?: PersonActivityData; listeners: Set<() => void> };
// Share the loaded, caller-visible roster rather than fetching another person's
// sessions or reconstructing a second cache in each transcript mention.
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
    private readonly data: PersonActivityData,
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
  source.listeners.add(changed);
  return {
    get data() {
      return source.data;
    },
    dispose: () => {
      source.listeners.delete(changed);
    },
  };
}
