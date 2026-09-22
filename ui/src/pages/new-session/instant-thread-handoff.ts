import type { RouteLocation } from "@openclaw/uirouter";
import type { ApplicationContext } from "../../app/context.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { beginInstantThreadNavigation } from "./instant-thread-navigation.ts";
import {
  retainInstantThreadRestore,
  type InstantThreadRestore,
  type RetainedNewSessionDraft,
} from "./instant-thread-restore.ts";

const active = new WeakMap<ApplicationContext, InstantThreadHandoff>();

/** Prepare the key before create, but claim the page only after create starts. */
export function prepareInstantThreadHandoff(options: {
  context: ApplicationContext;
  params: SessionCreateParams;
  resumed: boolean;
  enabled: boolean;
  agentId: string;
  retainDraft: (() => RetainedNewSessionDraft | undefined) | undefined;
  message: Parameters<ApplicationContext["chatSubmissions"]["beginCreate"]>[0]["message"];
}): (() => InstantThreadHandoff | undefined) | undefined {
  const { context, params, agentId, retainDraft } = options;
  if (!options.enabled || !context.gateway.snapshot.hello?.auth?.recoveryScope || !retainDraft) {
    return undefined;
  }
  const key =
    (options.resumed ? params.key : undefined) ??
    `agent:${agentId}:dashboard:${params.incognito ? "incognito-" : ""}${generateUUID()}`;
  if (!options.resumed) {
    params.key = key;
  }
  return () => {
    const draft = retainDraft();
    return draft
      ? new InstantThreadHandoff(context, key, agentId, draft, options.message)
      : undefined;
  };
}

/**
 * A transient route owns the original draft element, not a copy of its controllers.
 * Its attachment custody, selection flags and frozen startup intent survive rollback.
 * No draft bytes are persisted here, including incognito drafts.
 */
export class InstantThreadHandoff {
  private readonly creation;
  private readonly client;
  private readonly hello;
  private readonly gatewayUrl;
  private readonly recoveryScope;
  private readonly previousSessionKey: ApplicationContext["gateway"]["snapshot"]["sessionKey"];
  private readonly previousAgentId: ApplicationContext["agentSelection"]["state"]["selectedId"];
  private readonly returnLocation: RouteLocation;
  private readonly transition;
  private stopGateway = () => {};
  private clearPendingCreate = () => {};
  private disposed = false;
  private admittedSelection: { key: string; agentId: string } | undefined;
  private readonly lifetime = new AbortController();
  private rollingBack: Promise<void> | undefined;

  constructor(
    private readonly context: ApplicationContext,
    readonly key: string,
    agentId: string,
    private readonly draft: RetainedNewSessionDraft,
    message: Parameters<ApplicationContext["chatSubmissions"]["beginCreate"]>[0]["message"],
  ) {
    this.creation = { sessionKey: key, admitted: false };
    this.client = context.gateway.snapshot.client;
    this.hello = context.gateway.snapshot.hello;
    this.gatewayUrl = context.gateway.connection.gatewayUrl;
    this.recoveryScope = this.hello?.auth?.recoveryScope;
    const previous = active.get(context);
    this.previousSessionKey = context.gateway.snapshot.sessionKey;
    this.previousAgentId = context.agentSelection.state.selectedId;
    previous?.dispose();
    this.returnLocation = {
      pathname: globalThis.location.pathname,
      search: globalThis.location.search,
      hash: globalThis.location.hash,
    };
    active.set(context, this);
    const options = sessionNavigationTarget({
      context,
      face: "chat",
      sessionKey: key,
      agentId,
      // A never-admitted preview cannot depend on an expiring short-key lookup.
      exactKey: true,
    }).options;
    // Do not carry URL hints or focus cleanup that would commit this transient URL.
    const target = { pathname: options.pathname, search: "", hash: "" };
    // The route renders the provisional key, but saved/global selection stays
    // on the last admitted session until StartedSessionNavigation adopts it.
    this.transition = beginInstantThreadNavigation(context, "chat", target);
    this.clearPendingCreate = context.chatSubmissions.beginCreate({
      creation: this.creation,
      message,
      // This transaction owns live identity/navigation authority. The display store
      // consumes that decision instead of maintaining a second authentication snapshot.
      canDisplay: () => this.canDisplay(),
    });
    this.transition.signal.addEventListener("abort", this.onLeave, { once: true });
    this.stopGateway = context.gateway.subscribe(() => {
      const snapshot = context.gateway.snapshot;
      if (
        snapshot.phase !== "connected" ||
        snapshot.hello !== this.hello ||
        snapshot.client !== this.client ||
        context.gateway.connection.gatewayUrl !== this.gatewayUrl ||
        snapshot.hello?.auth?.recoveryScope !== this.recoveryScope
      ) {
        // Freeze the existing startup on transport loss. Restore only after the
        // next authenticated hello decides principal and boot ownership.
        if (
          snapshot.phase !== "connected" &&
          context.gateway.connection.gatewayUrl === this.gatewayUrl
        ) {
          draft.synchronizeGateway();
        }
        void this.rollback();
      }
    });
  }

  private sameIdentity() {
    const { gateway } = this.context;
    return (
      Boolean(this.recoveryScope) &&
      gateway.connection.gatewayUrl === this.gatewayUrl &&
      gateway.snapshot.phase === "connected" &&
      gateway.snapshot.hello?.auth?.recoveryScope === this.recoveryScope
    );
  }

  private canDisplay() {
    return (
      this.sameIdentity() &&
      this.context.gateway.snapshot.client === this.client &&
      this.context.gateway.snapshot.hello === this.hello
    );
  }

  private ownsSelection() {
    const sessionKey = this.admittedSelection?.key ?? this.previousSessionKey;
    const agentId = this.admittedSelection?.agentId ?? this.previousAgentId;
    return (
      this.context.gateway.snapshot.sessionKey === sessionKey &&
      this.context.agentSelection.state.selectedId === agentId
    );
  }

  private readonly onLeave = () => {
    this.dispose();
  };

  async waitForReady() {
    // A preview load failure is not a newer navigation. The create can still
    // succeed and must be handed to the confirmed-session navigation owner.
    await this.transition.ready;
  }

  /** Read live authority synchronously at the publication boundary. */
  isCurrent() {
    return (
      !this.disposed &&
      !this.rollingBack &&
      active.get(this.context) === this &&
      this.transition.isActive() &&
      this.canDisplay() &&
      this.ownsSelection()
    );
  }

  rollback(): Promise<void> {
    this.rollingBack ??= this.restore();
    return this.rollingBack;
  }

  private async restore() {
    await this.transition.ready;
    try {
      await waitForGatewayClient(this.context.gateway, this.lifetime.signal);
    } catch {
      return;
    }
    if (this.disposed || active.get(this.context) !== this || !this.transition.isActive()) {
      return;
    }
    const sameOwner = this.sameIdentity() && this.ownsSelection();
    this.transition.dispose();
    this.stopGateway();
    const restoredAgentId = this.context.agentSelection.state.selectedId;
    const restore: InstantThreadRestore = {
      draft: this.draft,
      search: this.returnLocation.search ?? "",
      owns: () => active.get(this.context) === this && !this.disposed && this.sameIdentity(),
      // Recheck at render time too: authentication can change while the
      // rollback route is loading, or while its data remains in router cache.
      canDisplay: () =>
        this.sameIdentity() && this.context.agentSelection.state.selectedId === restoredAgentId,
    };
    let clearRestore = () => {};
    if (sameOwner) {
      this.draft.synchronizeGateway();
      clearRestore = retainInstantThreadRestore(this.context, restore);
    }
    try {
      const rollback = beginInstantThreadNavigation(
        this.context,
        "new-session",
        this.returnLocation,
      );
      await rollback.ready;
      // Route renderers publish through Lit microtasks after the router settles.
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 0);
      });
      rollback.dispose();
    } finally {
      clearRestore();
      this.dispose();
    }
  }

  admitted(key: string, agentId: string) {
    // Confirmed navigation adopts selection synchronously. If navigation fails,
    // rollback may retain that admitted session for a navigation-only retry.
    this.admittedSelection = { key, agentId };
    // A canonical replacement must not activate the never-admitted preview key.
    if (!this.disposed && key === this.key) {
      this.creation.admitted = true;
      this.clearPendingCreate();
    }
  }

  /** Stop navigation tracking before committing the confirmed key. */
  commit() {
    if (this.disposed || this.rollingBack || !this.transition.isActive() || !this.canDisplay()) {
      return false;
    }
    this.transition.dispose();
    this.stopGateway();
    return true;
  }

  async finish() {
    await this.rollingBack;
    this.dispose();
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lifetime.abort();
    this.clearPendingCreate();
    this.transition.dispose();
    this.stopGateway();
    if (active.get(this.context) === this) {
      active.delete(this.context);
    }
    this.draft.release();
  }
}
