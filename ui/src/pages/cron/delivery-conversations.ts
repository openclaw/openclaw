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

// The editor owns this bounded target directory; account and topic routing stay
// operator-authored. Deferred completions must prove the editor still owns it.
export class DeliveryConversationsController {
  conversations: ConversationListItem[] = [];
  error: string | null = null;
  private requestId = 0;
  // Page, connection, and admin scope can survive an editor swap.
  private editorGeneration = 0;
  // Compare the published route with the current form after a save.
  private readRoute: DirectoryRoute | null = null;

  constructor(private readonly host: DeliveryConversationsHost) {}

  clear(cronState: CronState = this.host.currentCronState()) {
    this.requestId += 1;
    this.conversations = [];
    this.error = null;
    this.readRoute = null;
    this.host.notify(cronState);
  }

  get generation(): number {
    return this.editorGeneration;
  }

  retireEditor(cronState: CronState = this.host.currentCronState()) {
    this.editorGeneration += 1;
    this.clear(cronState);
  }

  openEditor() {
    this.editorGeneration += 1;
    void this.load();
  }

  retireExitedEditor(
    cronState: CronState,
    connectionScope: GatewayConnectionScope | null,
    editorGeneration: number,
  ) {
    if (this.ownedBy(cronState, connectionScope, editorGeneration)) {
      this.retireEditor(cronState);
    }
  }

  // Saving an edit reloads its directory; creating a job returns to overview.
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
