import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import {
  listStoredChatOutboxes,
  type StoredChatOutbox,
} from "../../lib/chat/outbox-store-projection.ts";
import {
  storedChatOutboxScopeKey,
  type StoredChatOutboxScope,
} from "../../lib/chat/outbox-store.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
} from "../../lib/sessions/session-key.ts";
import { readSessionChangedEvent } from "../../lib/sessions/session-row-reconcile.ts";
import {
  captureChatCommandTarget,
  confirmConversationResetForCurrentSession,
  dispatchChatSlashCommand,
  readChatResetTargetAccess,
  type ChatCommandTarget,
  type ChatCommandResetOptions,
} from "./chat-commands.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import {
  isInterruptedChatInput,
  readCurrentStoredChatHistory,
  readStoredChatOutbox,
} from "./chat-outbox-receipts.ts";
import {
  consumeChatOutboxRetry,
  scheduleChatOutboxRetry,
  settleChatOutboxRetry,
} from "./chat-outbox-retry.ts";
import {
  anyChatOutboxPaneMatches,
  readQueuedMessageById,
  removeQueuedMessageWithoutReleasing,
  syncVisibleChatQueueProjection,
  updateQueuedMessage,
} from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  chatSendHoldReason,
  OFFLINE_QUEUE_STORAGE_ERROR,
  UNCONFIRMED_CHAT_SEND_ERROR,
  surfaceChatDeliveryFailure,
} from "./chat-send-support.ts";
import { isQueuedMessageBeingEdited } from "./queued-message-edit.ts";
import { isChatBusy } from "./run-lifecycle.ts";

export type QueuedChatSendResult = "sent" | "pending" | "failed";
export type QueuedChatStorageMode = "durable" | "memory";
export type QueuedChatSendOptions = {
  /** Fresh selected-session sends may let the Gateway resolve its effective active-run mode. */
  allowActiveRunSend?: boolean;
  /** Confirmation-triggered sends retain their UI owner across preparation waits. */
  canDispatch?: () => boolean;
  /** Exact submit-time leaf; restored drains omit it so intervening advances park the draft. */
  expectedLeafEntryId?: string | null;
  pendingSettings?: Promise<boolean>;
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
  previousMentions?: ChatQueueItem["mentions"];
  restoreAttachments?: boolean;
  restoreDraft?: boolean;
  /** Recognized remote commands remain editable when the Gateway rejects them. */
  restoreOnTerminalFailure?: boolean;
  routingSessionKey?: string;
  storageMode?: QueuedChatStorageMode;
  target?: ChatCommandTarget;
};

export type ChatOutboxDrainDependencies = {
  sendQueuedChatMessage: (
    host: ChatHost,
    id: string,
    opts?: QueuedChatSendOptions,
    queuedSessionKey?: string,
  ) => Promise<QueuedChatSendResult>;
  sendResetSlashCommand: (
    host: ChatHost,
    message: string,
    opts: ChatCommandResetOptions,
  ) => Promise<void>;
  setChatError: (
    host: { lastError?: string | null; chatError?: string | null },
    error: string | null,
  ) => void;
};

type StoredChatOutboxDrainLane = {
  owner: { host: ChatHost; connectionEpoch: number | undefined };
  freshAdmissions: Set<string>;
  host: ChatHost;
  outcomes: Map<string, QueuedChatSendResult>;
  pendingOptions: Map<string, QueuedChatSendOptions>;
  promise: Promise<void>;
  rerun: boolean;
  waitingForVisibleOwner?: boolean;
};

const observedOutboxEvents = new WeakMap<GatewayBrowserClient, WeakSet<GatewayEventFrame>>();

const UNCERTAIN_CLEAR_SUCCESSOR_ERROR =
  "A preceding /clear may have completed. Review the current conversation before retrying.";

const storedChatOutboxLanes = new WeakMap<
  GatewayBrowserClient,
  Map<string, StoredChatOutboxDrainLane>
>();

export function scheduleStoredChatOutboxRetry(
  host: ChatHost,
  scope: StoredChatOutboxScope,
  delayMs: number,
  dependencies: ChatOutboxDrainDependencies,
  suppressGenericWake = true,
) {
  const key = storedChatOutboxScopeKey(scope);
  scheduleChatOutboxRetry(
    host,
    key,
    delayMs,
    (owner) => void scheduleStoredChatOutboxDrain(owner, scope, dependencies),
    suppressGenericWake,
  );
}

async function reconcileStoredChatOutboxHead(
  host: ChatHost,
  outbox: StoredChatOutbox,
  item: ChatQueueItem,
  dependencies: ChatOutboxDrainDependencies,
  retryUnconfirmed = false,
): Promise<"blocked" | "continue" | "send"> {
  const client = host.client;
  const connectionEpoch = host.connectionEpoch;
  if (!client || !host.connected) {
    return "blocked";
  }
  // Never-attempted input needs only the session row. Attempted input still needs
  // history to retire delivered messages, even while a run streams.
  const neverAttempted =
    (item.sendAttempts ?? 0) === 0 && item.sendRequestStartedAtMs === undefined;
  if (neverAttempted && item.queueMode && item.sendState !== "unconfirmed") {
    return "send";
  }
  if (neverAttempted) {
    const row =
      !isUiGlobalSessionKey(outbox.sessionKey) || host.sessions.state.agentId === outbox.agentId
        ? host.sessions.state.result?.sessions.find((session) =>
            areUiSessionKeysEquivalent(session.key, outbox.sessionKey),
          )
        : undefined;
    if (row && isSessionRunActive(row)) {
      return "blocked";
    }
  }
  const historyArgs = [
    host,
    outbox,
    item,
    client,
    connectionEpoch,
    (delayMs: number) => scheduleStoredChatOutboxRetry(host, outbox, delayMs, dependencies),
  ] as const;
  const history = await readCurrentStoredChatHistory(...historyArgs);
  if (
    typeof history !== "string" &&
    isInterruptedChatInput(history, item) &&
    (item.queueMode === "steer" ||
      item.queueMode === "interrupt" ||
      !(visibleSessionMatches(host, outbox.sessionKey, outbox.agentId) && isChatBusy(host)))
  ) {
    return "send";
  }
  // Passive unknown sends need positive delivery proof; only an explicit retry
  // may continue through idle reconciliation to the same idempotency key.
  if (
    history === "blocked" ||
    history === "continue" ||
    (item.sendState === "unconfirmed" && !retryUnconfirmed)
  ) {
    return history === "continue" ? "continue" : "blocked";
  }
  if (visibleSessionMatches(host, outbox.sessionKey, outbox.agentId) && isChatBusy(host)) {
    return "blocked";
  }
  if ((item.sendAttempts ?? 0) > 0) {
    // History and run metadata are non-atomic; verify idle before parking unknown.
    const verifiedHistory = await readCurrentStoredChatHistory(...historyArgs);
    if (verifiedHistory === "blocked" || verifiedHistory === "continue") {
      return verifiedHistory;
    }
    const liveSendCurrent = anyChatOutboxPaneMatches(host, (pane) => {
      const liveItem = pane.chatQueue.find((entry) => entry.id === item.id);
      return (
        liveItem?.sendState === "sending" &&
        sameQueuedDeliveryVersion(liveItem, { ...item, sendState: "sending" })
      );
    });
    if (liveSendCurrent) {
      // Elapsed time cannot turn a current-connection send into reconnect uncertainty.
      return "blocked";
    }
    if (retryUnconfirmed) {
      return "send";
    }
    const parked = updateQueuedMessage(host, item.id, (entry) => ({
      ...entry,
      sendError: UNCONFIRMED_CHAT_SEND_ERROR,
      sendState: "unconfirmed",
    }));
    if (parked) {
      surfaceChatDeliveryFailure(
        host,
        outbox.sessionKey,
        outbox.agentId,
        UNCONFIRMED_CHAT_SEND_ERROR,
        // The parked bubble's inline footer is the visible outcome; hidden
        // panes still get the named toast. Command chips never park here.
        { inline: !item.localCommandName },
      );
    }
    return "blocked";
  }
  return "send";
}

async function drainStoredChatOutbox(
  lane: StoredChatOutboxDrainLane,
  scope: StoredChatOutboxScope,
  dependencies: ChatOutboxDrainDependencies,
): Promise<"blocked" | "empty"> {
  while (true) {
    const host = lane.host;
    if (!host.connected || !host.client || chatSendHoldReason(host, scope.sessionKey)) {
      return "blocked";
    }
    const outbox = readStoredChatOutbox(host, scope);
    if (!outbox) {
      return "empty";
    }
    // Explicit active-run sends may bypass older queued rows; other admissions keep FIFO.
    const freshActiveRunItem = outbox.queue.find(
      (entry) => lane.freshAdmissions.has(entry.id) && Boolean(entry.queueMode),
    );
    const storedItem =
      freshActiveRunItem ??
      outbox.queue.find(
        (entry) =>
          lane.freshAdmissions.has(entry.id) ||
          entry.sendState !== "failed" ||
          entry.localCommandName,
      );
    if (!storedItem) {
      return "empty";
    }
    const freshItem = lane.freshAdmissions.has(storedItem.id);
    const item = freshItem
      ? (readQueuedMessageById(host, storedItem.id) ?? storedItem)
      : storedItem;
    if (item.sendState === "failed" && !freshItem) {
      return "empty";
    }
    if (
      // Browser input still belongs to the foreground submitter. Only its fresh
      // admission may deliver this version; passive wakes must not drop its fence.
      (!freshItem && chatOutboxOwner(host).hasPendingSubmission(outbox, storedItem)) ||
      (item.sendState === "unconfirmed" && (!item.sendRunId || item.localCommandName)) ||
      (item.sendState === "waiting-model" && !lane.pendingOptions.has(item.id)) ||
      // An open edit owns this row: sending the superseded text would deliver a
      // message the operator is visibly rewriting. The queue behind it waits,
      // which is the same contract the row's held position promises.
      isQueuedMessageBeingEdited(host, item.id)
    ) {
      syncVisibleChatQueueProjection(host);
      return "blocked";
    }
    const visible = visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
    if (item.localCommandName) {
      const setCommandState = (sendState: ChatQueueItem["sendState"], sendError?: string) =>
        updateQueuedMessage(host, item.id, (entry) => ({
          ...entry,
          sendError,
          sendState,
        }));
      if (!visible || isChatBusy(host)) {
        lane.waitingForVisibleOwner = !visible;
        lane.freshAdmissions.delete(item.id);
        lane.pendingOptions.delete(item.id);
        return "blocked";
      }
      syncVisibleChatQueueProjection(host);
      if (item.localCommandName === "reset") {
        if ((item.sendAttempts ?? 0) > 0 || item.sendRequestStartedAtMs !== undefined) {
          setCommandState("unconfirmed", UNCONFIRMED_CHAT_SEND_ERROR);
          return "blocked";
        }
        const resetTarget = captureChatCommandTarget(host);
        if (!resetTarget) {
          setCommandState("failed", "The Gateway connection changed. Retry the command.");
          return "blocked";
        }
        const initialAccess = readChatResetTargetAccess(host, resetTarget);
        if (!initialAccess.allowed) {
          setCommandState("failed", initialAccess.reason);
          dependencies.setChatError(host, initialAccess.reason);
          return "blocked";
        }
        const confirmation = await confirmConversationResetForCurrentSession(host, {
          sessionKey: outbox.sessionKey,
          ...(outbox.agentId ? { agentId: outbox.agentId } : {}),
        });
        if (confirmation === "deferred") {
          setCommandState("waiting-idle");
          return "blocked";
        }
        if (confirmation === "cancelled") {
          if (!removeQueuedMessageWithoutReleasing(host, item.id)) {
            return "blocked";
          }
          continue;
        }
        const currentAccess = readChatResetTargetAccess(host, resetTarget);
        if (!currentAccess.allowed) {
          setCommandState("failed", currentAccess.reason);
          dependencies.setChatError(host, currentAccess.reason);
          return "blocked";
        }
        lane.pendingOptions.set(item.id, {
          ...lane.pendingOptions.get(item.id),
          target: resetTarget,
        });
        const result = await dependencies.sendQueuedChatMessage(
          host,
          item.id,
          lane.pendingOptions.get(item.id),
          outbox.sessionKey,
        );
        lane.outcomes.set(item.id, result);
        lane.pendingOptions.delete(item.id);
        if (result !== "sent") {
          return "blocked";
        }
        continue;
      }
      // Consume the live admission token before command execution or manual retry.
      const freshAdmission = lane.freshAdmissions.delete(item.id);
      lane.pendingOptions.delete(item.id);
      if (!freshAdmission) {
        const reconciled = await reconcileStoredChatOutboxHead(host, outbox, item, dependencies);
        if (reconciled === "blocked") {
          return "blocked";
        }
        if (reconciled === "continue") {
          continue;
        }
      }
      if (chatSendHoldReason(host, outbox.sessionKey)) {
        return "blocked";
      }
      // Claim before execution to preserve FIFO and crash-review state.
      const claimed = setCommandState("executing-command");
      if (!claimed) {
        return "blocked";
      }
      const commandClient = host.client;
      const commandConnectionEpoch = host.connectionEpoch;
      const commandScopeIsCurrent = () =>
        host.connected &&
        host.client === commandClient &&
        host.connectionEpoch === commandConnectionEpoch &&
        visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
      const failCommand = (error: string, expose = false): "blocked" => {
        const updated = setCommandState("failed", error);
        if (!updated || expose) {
          surfaceChatDeliveryFailure(
            host,
            outbox.sessionKey,
            outbox.agentId,
            updated ? error : OFFLINE_QUEUE_STORAGE_ERROR,
          );
        }
        return "blocked";
      };
      try {
        const dispatchResult = await dispatchChatSlashCommand(
          host,
          claimed.localCommandName ?? item.localCommandName,
          claimed.localCommandArgs ?? "",
          {
            sendResetMessage: (message, resetOpts) =>
              dependencies.sendResetSlashCommand(host, message, resetOpts),
          },
        );
        if (dispatchResult === "deferred") {
          setCommandState("waiting-idle");
          return "blocked";
        }
        if (dispatchResult === "failed") {
          // A still-current scope already saw the dispatcher's inline error.
          // After a route switch the dispatcher withholds it and the pane is
          // gone, so the terminal failure must surface globally. A stale scope
          // with the pane still visible (connection replaced) keeps the failed
          // queue chip instead: the new connection owns the inline surface.
          const commandStillCurrent = commandScopeIsCurrent();
          const error =
            (commandStillCurrent ? host.lastError : null) ??
            `Command /${item.localCommandName} failed.`;
          const paneHidden = !visibleSessionMatches(host, outbox.sessionKey, outbox.agentId);
          return failCommand(error, !commandStillCurrent && paneHidden);
        }
        if (dispatchResult === "uncertain") {
          const currentOutbox = readStoredChatOutbox(host, outbox);
          const currentIndex =
            currentOutbox?.queue.findIndex((entry) => entry.id === item.id) ?? -1;
          const successor = currentIndex >= 0 ? currentOutbox?.queue[currentIndex + 1] : undefined;
          if (
            successor &&
            !updateQueuedMessage(host, successor.id, (entry) => ({
              ...entry,
              sendError: UNCERTAIN_CLEAR_SUCCESSOR_ERROR,
              sendState: "unconfirmed",
            }))
          ) {
            dependencies.setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
            // Keep the claimed clear row as the reload-safe barrier.
            return "blocked";
          }
        }
        if (!removeQueuedMessageWithoutReleasing(host, item.id)) {
          surfaceChatDeliveryFailure(
            host,
            outbox.sessionKey,
            outbox.agentId,
            OFFLINE_QUEUE_STORAGE_ERROR,
          );
          return "blocked";
        }
        if (dispatchResult === "uncertain") {
          // The unconfirmed successor is the FIFO lane's durable review barrier.
          return "blocked";
        }
        if (commandScopeIsCurrent()) {
          dependencies.setChatError(host, null);
        }
      } catch (err) {
        return failCommand(formatUiError(err), true);
      }
      continue;
    }
    if (isUiGlobalSessionKey(outbox.sessionKey) && !outbox.agentId) {
      lane.freshAdmissions.delete(item.id);
      lane.pendingOptions.delete(item.id);
      return "blocked";
    }
    // Consume provenance before await; restored/deferred rows reconcile history.
    const freshAdmission = lane.freshAdmissions.delete(item.id);
    const pendingOptions = lane.pendingOptions.get(item.id);
    const retryUnconfirmed = freshAdmission && item.sendState === "unconfirmed";
    if (!freshAdmission || retryUnconfirmed || !visible) {
      // History reconciles canonical stored versions, not the live row's transport alias.
      const reconciled = await reconcileStoredChatOutboxHead(
        host,
        outbox,
        storedItem,
        dependencies,
        retryUnconfirmed,
      );
      if (reconciled === "blocked") {
        return "blocked";
      }
      if (reconciled === "continue") {
        continue;
      }
    }
    const currentOutbox = readStoredChatOutbox(host, scope);
    const currentItem = freshAdmission
      ? readQueuedMessageById(host, item.id)
      : currentOutbox?.queue.find((entry) => entry.id === item.id);
    if (!currentOutbox || !currentItem || !sameQueuedDeliveryVersion(currentItem, item)) {
      lane.pendingOptions.delete(item.id);
      continue;
    }
    syncVisibleChatQueueProjection(host);
    const result = await dependencies.sendQueuedChatMessage(
      host,
      item.id,
      visible ? pendingOptions : { ...pendingOptions, routingSessionKey: undefined },
      outbox.sessionKey,
    );
    lane.outcomes.set(item.id, result);
    lane.pendingOptions.delete(item.id);
    if (result === "pending") {
      const current = readStoredChatOutbox(host, scope)?.queue.find(
        (entry) => entry.id === item.id,
      );
      if (!current || current.orderKey !== item.orderKey) {
        // A removal or move during preparation invalidates this selection.
        // Reselect immediately so the newly ordered head does not lose its wakeup.
        continue;
      }
      // A later submission still owns its wakeup if this row became stale while waiting.
      if (!pendingOptions?.pendingSettings && lane.freshAdmissions.size === 0) {
        lane.rerun = false;
      }
      return "blocked";
    }
    if (result === "failed") {
      continue;
    }
  }
}

export async function scheduleStoredChatOutboxDrain(
  host: ChatHost,
  scope: StoredChatOutboxScope,
  dependencies: ChatOutboxDrainDependencies,
  itemId?: string,
  options?: QueuedChatSendOptions,
  changed?: boolean,
): Promise<QueuedChatSendResult | undefined> {
  const client = host.client;
  if (!host.connected || !client) {
    return undefined;
  }
  const key = storedChatOutboxScopeKey(scope);
  const lanes = storedChatOutboxLanes.get(client) ?? new Map<string, StoredChatOutboxDrainLane>();
  storedChatOutboxLanes.set(client, lanes);
  const candidateOwnsScope = visibleSessionMatches(host, scope.sessionKey, scope.agentId);
  if (consumeChatOutboxRetry(host, key, candidateOwnsScope, itemId)) {
    return undefined;
  }
  // Drain ownership follows the live client, never a disconnected pending RPC.
  const existing = lanes.get(key);
  if (existing) {
    const ownerRequestedRecovery = existing.host === host;
    const ownerConnectionChanged =
      !existing.owner.host.connected ||
      existing.owner.host.client !== client ||
      existing.owner.connectionEpoch !== existing.owner.host.connectionEpoch;
    // Keep a connected visible owner for local commands across split-pane reruns.
    if (
      !existing.host.connected ||
      existing.host.client !== client ||
      (!visibleSessionMatches(existing.host, scope.sessionKey, scope.agentId) && candidateOwnsScope)
    ) {
      existing.host = host;
      existing.rerun ||= existing.waitingForVisibleOwner === true && candidateOwnsScope;
    }
    existing.rerun ||=
      (changed ?? ownerRequestedRecovery) || Boolean(itemId) || ownerConnectionChanged;
    if (itemId && options) {
      existing.pendingOptions.set(itemId, options);
    }
    if (itemId) {
      existing.freshAdmissions.add(itemId);
    }
    if (!itemId && existing.pendingOptions.size) {
      return undefined;
    }
    await existing.promise;
    return itemId ? existing.outcomes.get(itemId) : undefined;
  }
  const lane: StoredChatOutboxDrainLane = {
    owner: { host, connectionEpoch: host.connectionEpoch },
    freshAdmissions: new Set(itemId ? [itemId] : []),
    host,
    outcomes: new Map(),
    pendingOptions: new Map(itemId && options ? [[itemId, options]] : []),
    promise: Promise.resolve(),
    rerun: false,
  };
  lanes.set(key, lane);
  lane.promise = (async () => {
    do {
      lane.rerun = false;
      lane.waitingForVisibleOwner = false;
      lane.owner = { host: lane.host, connectionEpoch: lane.host.connectionEpoch };
      await drainStoredChatOutbox(lane, scope, dependencies);
    } while (lane.rerun);
  })();
  try {
    await lane.promise;
    settleChatOutboxRetry(client, key);
    return itemId ? lane.outcomes.get(itemId) : undefined;
  } finally {
    if (lanes.get(key) === lane) {
      lanes.delete(key);
    }
  }
}

export async function resumeStoredChatOutboxes(
  host: ChatHost,
  dependencies: ChatOutboxDrainDependencies,
  event?: GatewayEventFrame,
) {
  const client = host.client;
  if (!host.connected || !client) {
    return;
  }
  // Refresh credential ownership; callers own frame-coalesced rendering.
  syncVisibleChatQueueProjection(host, { requestUpdate: false });
  const eventScope = event ? readSessionChangedEvent(event.payload) : undefined;
  if (event && !eventScope) {
    return;
  }
  const outboxes = listStoredChatOutboxes(host).filter(
    (outbox) =>
      !eventScope ||
      (areUiSessionKeysEquivalent(outbox.sessionKey, eventScope.key) &&
        (!isUiGlobalSessionKey(outbox.sessionKey) ||
          (eventScope.agentId !== null &&
            outbox.agentId === normalizeAgentId(eventScope.agentId)))),
  );
  const observed = observedOutboxEvents.get(client) ?? new WeakSet<GatewayEventFrame>();
  observedOutboxEvents.set(client, observed);
  const changed = event ? !observed.has(event) : undefined;
  if (event && outboxes.length > 0) {
    observed.add(event);
  }
  await Promise.allSettled(
    outboxes
      .filter(
        (outbox) =>
          !event ||
          changed ||
          storedChatOutboxLanes.get(client)?.has(storedChatOutboxScopeKey(outbox)),
      )
      .map((outbox) =>
        scheduleStoredChatOutboxDrain(host, outbox, dependencies, undefined, undefined, changed),
      ),
  );
}

export async function flushStoredChatOutbox(
  host: ChatHost,
  dependencies: ChatOutboxDrainDependencies,
) {
  const outbox = listStoredChatOutboxes(host).find((candidate) =>
    visibleSessionMatches(host, candidate.sessionKey, candidate.agentId),
  );
  if (outbox) {
    await scheduleStoredChatOutboxDrain(host, outbox, dependencies, undefined, undefined, true);
  }
}
