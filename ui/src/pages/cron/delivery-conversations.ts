import type { ConversationListItem, ConversationListResult } from "@openclaw/gateway-protocol";
import type { CronFormState, CronState } from "../../lib/cron/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";

// Topics belong to an exact delivery route; retain one only when that route survives
// or the same patch supplies a replacement.
export function invalidateStaleDeliveryRoute(
  current: CronFormState,
  patch: Partial<CronFormState>,
): Partial<CronFormState> {
  const deliveryIdentityChanged =
    ("deliveryMode" in patch && patch.deliveryMode !== current.deliveryMode) ||
    ("deliveryChannel" in patch && patch.deliveryChannel !== current.deliveryChannel) ||
    ("deliveryAccountId" in patch && patch.deliveryAccountId !== current.deliveryAccountId) ||
    ("deliveryTo" in patch && patch.deliveryTo !== current.deliveryTo) ||
    ("agentId" in patch && patch.agentId !== current.agentId);
  return deliveryIdentityChanged && patch.deliveryThreadId === undefined
    ? { ...patch, deliveryThreadId: undefined }
    : patch;
}

// Account filtering is local: only request-key changes rediscover the directory.
export function requiresDirectoryReload(current: CronFormState, next: CronFormState): boolean {
  return (
    next.deliveryMode !== current.deliveryMode ||
    next.deliveryChannel !== current.deliveryChannel ||
    next.agentId !== current.agentId
  );
}

/** The `conversations.list` request key an editor's form implies. */
type DirectoryRoute = { mode: string; channel: string; agentId: string };

function readDirectoryRoute(cronState: CronState): DirectoryRoute {
  return {
    mode: cronState.cronForm.deliveryMode,
    channel: cronState.cronForm.deliveryChannel.trim(),
    agentId: cronState.cronForm.agentId.trim() || cronState.cronAgentId?.trim() || "",
  };
}

function sameDirectoryRoute(read: DirectoryRoute | null, next: DirectoryRoute): boolean {
  return (
    read !== null &&
    read.mode === next.mode &&
    read.channel === next.channel &&
    read.agentId === next.agentId
  );
}

export type DeliveryConversationsHost = {
  /** The page state that currently owns the editor. */
  currentCronState: () => CronState;
  /** Admin access is revalidated per request because it can drop mid-flight. */
  canManage: () => boolean;
  captureConnection: () => GatewayConnectionScope | null;
  isCurrentConnection: (scope: GatewayConnectionScope) => boolean;
  /** Re-render the page for the state that published the change. */
  notify: (cronState: CronState) => void;
};

/**
 * Owns the Automations editor's recipient directory: the cached conversations,
 * the published error, and the request generation. This state is page-owned
 * rather than CronState-owned, so a continuation that outlived the editor it
 * started in must prove ownership before clearing the cache or reading again.
 *
 * The directory is a bounded read, so it is only ever a source of **target**
 * suggestions. Account and topic routing stay operator-authored; nothing here
 * infers them.
 */
export class DeliveryConversationsController {
  conversations: ConversationListItem[] = [];
  error: string | null = null;
  private requestId = 0;
  /**
   * Identifies the editor session that owns the cache. A continuation captures
   * it before awaiting and presents it back, which is the only way to tell "my
   * editor exited" from "a replacement editor owns discovery now": the page,
   * the connection, and the admin scope all survive an editor swap.
   */
  private editorGeneration = 0;
  /**
   * The route the cache was last read against. Keeping it here rather than in
   * the caller is what lets a continuation ask whether the editor still targets
   * the channel and agent the cached rows describe, without having to snapshot
   * the form itself before every await.
   */
  private readRoute: DirectoryRoute | null = null;

  constructor(private readonly host: DeliveryConversationsHost) {}

  /** Retire every in-flight read and drop the cached suggestions and error. */
  clear(cronState: CronState = this.host.currentCronState()) {
    this.requestId += 1;
    this.conversations = [];
    this.error = null;
    this.readRoute = null;
    this.host.notify(cronState);
  }

  /** The generation a deferred continuation must present back to own the cache. */
  get generation(): number {
    return this.editorGeneration;
  }

  /** An editor session ended: retire its directory and stop answering for it. */
  retireEditor(cronState: CronState = this.host.currentCronState()) {
    this.editorGeneration += 1;
    this.clear(cronState);
  }

  /** An editor session began: it owns discovery from here, so read for it. */
  openEditor() {
    this.editorGeneration += 1;
    void this.load();
  }

  /**
   * Retire the directory for a continuation whose own editor confirmed its
   * exit. A continuation that no longer owns the cache — replaced page,
   * dropped connection, lost admin access, or a replacement editor — leaves it
   * alone rather than retiring someone else's in-flight read.
   */
  retireExitedEditor(
    cronState: CronState,
    connectionScope: GatewayConnectionScope | null,
    editorGeneration: number,
  ) {
    if (this.ownedBy(cronState, connectionScope, editorGeneration)) {
      this.retireEditor(cronState);
    }
  }

  /**
   * Resettle the directory after a save. A save that still owns discovery
   * drops the cache it read against, then reads again only when its editor
   * stayed open; a create hands off to the overview instead.
   */
  afterSave(
    cronState: CronState,
    connectionScope: GatewayConnectionScope | null,
    editorGeneration: number,
    stillEditing: boolean,
  ) {
    if (!this.ownedBy(cronState, connectionScope, editorGeneration)) {
      return;
    }
    this.clear(cronState);
    if (stillEditing) {
      void this.load(cronState);
    } else {
      this.editorGeneration += 1;
    }
  }

  // Revision-conflict recovery may replace the route despite `saved: false`.
  // Retire its stale suggestions and pending read, but keep unchanged routes quiet.
  reconcileRoute(
    cronState: CronState,
    connectionScope: GatewayConnectionScope | null,
    editorGeneration: number,
  ) {
    if (sameDirectoryRoute(this.readRoute, readDirectoryRoute(cronState))) {
      return;
    }
    this.afterSave(cronState, connectionScope, editorGeneration, Boolean(cronState.cronEditingJob));
  }

  /**
   * A continuation owns the directory only while its page, its connection, its
   * admin access, and the editor session it started in all survive.
   */
  ownedBy(
    cronState: CronState,
    connectionScope: GatewayConnectionScope | null,
    editorGeneration?: number,
  ): boolean {
    return (
      this.host.currentCronState() === cronState &&
      connectionScope !== null &&
      this.host.isCurrentConnection(connectionScope) &&
      this.host.canManage() &&
      (editorGeneration === undefined || this.editorGeneration === editorGeneration)
    );
  }

  async load(cronState: CronState = this.host.currentCronState()) {
    const requestId = ++this.requestId;
    this.conversations = [];
    this.error = null;
    this.host.notify(cronState);
    const client = cronState.client;
    // Recorded before the guards so a route that reads nothing is still the
    // route the (empty) cache answers for, and retrying its save stays quiet.
    const route = readDirectoryRoute(cronState);
    this.readRoute = route;
    const { mode, channel, agentId } = route;
    if (
      !this.host.canManage() ||
      !client ||
      mode !== "announce" ||
      !agentId ||
      channel === "last"
    ) {
      return;
    }
    const connectionScope = this.host.captureConnection();
    if (!connectionScope) {
      return;
    }
    const isCurrent = () =>
      requestId === this.requestId && this.ownedBy(cronState, connectionScope);
    try {
      const result = await client.request<ConversationListResult>("conversations.list", {
        agentId,
        channel,
        limit: 100,
      });
      if (isCurrent()) {
        // The directory is bounded, so it is authoritative only as a source of
        // target suggestions. Never infer hidden account or topic routing from it.
        this.conversations = result.conversations;
        this.error = null;
        this.host.notify(cronState);
      }
    } catch (error) {
      if (isCurrent()) {
        this.conversations = [];
        this.error = `Could not load recipient suggestions: ${formatUiError(error)}`;
        this.host.notify(cronState);
      }
    }
  }
}
