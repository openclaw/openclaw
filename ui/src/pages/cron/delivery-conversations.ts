import type { ConversationListItem, ConversationListResult } from "@openclaw/gateway-protocol";
import { createStore } from "solid-js";
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
    ("deliveryTarget" in patch && patch.deliveryTarget !== current.deliveryTarget) ||
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
    next.deliveryTarget !== current.deliveryTarget ||
    next.deliveryChannel !== current.deliveryChannel ||
    next.agentId !== current.agentId
  );
}

/** The `conversations.list` request key an editor's form implies. */
type DirectoryRoute = { mode: string; target: string; channel: string; agentId: string };

function readDirectoryRoute(cronState: CronState): DirectoryRoute {
  return {
    mode: cronState.cronForm.deliveryMode,
    target: cronState.cronForm.deliveryTarget,
    channel: cronState.cronForm.deliveryChannel.trim(),
    agentId: cronState.cronForm.agentId.trim() || cronState.cronAgentId?.trim() || "",
  };
}

function sameDirectoryRoute(read: DirectoryRoute | null, next: DirectoryRoute): boolean {
  return (
    read !== null &&
    read.mode === next.mode &&
    read.target === next.target &&
    read.channel === next.channel &&
    read.agentId === next.agentId
  );
}

type DeliveryConversationsDependencies = {
  /** The page state that currently owns the editor. */
  currentCronState: () => CronState;
  /** Admin access is revalidated per request because it can drop mid-flight. */
  canManage: () => boolean;
  captureConnection: () => GatewayConnectionScope | null;
  isCurrentConnection: (scope: GatewayConnectionScope) => boolean;
};

// The editor owns this bounded target directory; account and topic routing stay
// operator-authored. Deferred completions must prove the editor still owns it.
export function createDeliveryConversations(deps: DeliveryConversationsDependencies) {
  const [state, setState] = createStore<{
    conversations: ConversationListItem[];
    error: string | null;
  }>({ conversations: [], error: null });
  let requestId = 0;
  // Page, connection, and admin scope can survive an editor swap.
  let editorGeneration = 0;
  let readRoute: DirectoryRoute | null = null;

  function clear() {
    requestId += 1;
    setState((draft) => {
      draft.conversations = [];
      draft.error = null;
    });
    readRoute = null;
  }

  function retireEditor() {
    editorGeneration += 1;
    clear();
  }

  function openEditor() {
    editorGeneration += 1;
    void load();
  }

  function retireExitedEditor(
    cronState: CronState,
    connectionScope: GatewayConnectionScope | null,
    generation: number,
  ) {
    if (ownedBy(cronState, connectionScope, generation)) {
      retireEditor();
    }
  }

  // Saving an edit reloads its directory; creating a job returns to overview.
  function afterSave(
    cronState: CronState,
    connectionScope: GatewayConnectionScope | null,
    generation: number,
    stillEditing: boolean,
  ) {
    if (!ownedBy(cronState, connectionScope, generation)) {
      return;
    }
    clear();
    if (stillEditing) {
      void load(cronState);
    } else {
      editorGeneration += 1;
    }
  }

  // Revision-conflict recovery may replace the route despite `saved: false`.
  // Retire its stale suggestions and pending read, but keep unchanged routes quiet.
  function reconcileRoute(
    cronState: CronState,
    connectionScope: GatewayConnectionScope | null,
    generation: number,
  ) {
    if (sameDirectoryRoute(readRoute, readDirectoryRoute(cronState))) {
      return;
    }
    afterSave(cronState, connectionScope, generation, Boolean(cronState.cronEditingJob));
  }

  function ownedBy(
    cronState: CronState,
    connectionScope: GatewayConnectionScope | null,
    generation?: number,
  ): boolean {
    return (
      deps.currentCronState() === cronState &&
      connectionScope !== null &&
      deps.isCurrentConnection(connectionScope) &&
      deps.canManage() &&
      (generation === undefined || editorGeneration === generation)
    );
  }

  async function load(cronState: CronState = deps.currentCronState()) {
    const request = ++requestId;
    setState((draft) => {
      draft.conversations = [];
      draft.error = null;
    });
    const client = cronState.client;
    // Recorded before the guards so a route that reads nothing is still the
    // route the (empty) cache answers for, and retrying its save stays quiet.
    const route = readDirectoryRoute(cronState);
    readRoute = route;
    const { mode, channel, agentId } = route;
    if (
      !deps.canManage() ||
      !client ||
      mode !== "announce" ||
      route.target === "owner" ||
      !agentId ||
      channel === "last"
    ) {
      return;
    }
    const connectionScope = deps.captureConnection();
    if (!connectionScope) {
      return;
    }
    const isCurrent = () => request === requestId && ownedBy(cronState, connectionScope);
    try {
      const result = await client.request<ConversationListResult>("conversations.list", {
        agentId,
        channel,
        limit: 100,
      });
      if (isCurrent()) {
        // The directory is bounded, so it is authoritative only as a source of
        // target suggestions. Never infer hidden account or topic routing from it.
        setState((draft) => {
          draft.conversations = result.conversations;
          draft.error = null;
        });
      }
    } catch (error) {
      if (isCurrent()) {
        setState((draft) => {
          draft.conversations = [];
          draft.error = `Could not load recipient suggestions: ${formatUiError(error)}`;
        });
      }
    }
  }
  return {
    get conversations() {
      return state.conversations;
    },
    get error() {
      return state.error;
    },
    get generation() {
      return editorGeneration;
    },
    clear,
    retireEditor,
    openEditor,
    retireExitedEditor,
    afterSave,
    reconcileRoute,
    load,
  };
}
