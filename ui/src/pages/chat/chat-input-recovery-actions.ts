import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type { ChatMessageGetResult } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { t } from "../../i18n/index.ts";
import { registerChatInputRecoveryEnglish } from "../../i18n/locales/en-chat-input-recovery.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import { observeOutboxRecoveryOwner } from "../../lib/chat/outbox-payload-store.runtime.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import { resolveSourceMessageId } from "./chat-message-recovery.ts";
import { getChatPendingInputs, getChatRecoveryInputs } from "./chat-pending-inputs.ts";
import { readQueuedMessageById } from "./chat-queue.ts";
import { retryQueuedChatMessage } from "./chat-send-actions.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { isChatStopCommand } from "./run-lifecycle.ts";

registerChatInputRecoveryEnglish();

/** The application preference owner persists opaque, viewer-scoped keys, never payloads. */
export type ChatInputRecoveryDismissals = {
  has: (key: string) => boolean;
  add: (key: string) => boolean;
};
export type ChatInputRecoveryHost = ChatHost & {
  chatInputRecoveryDismissals?: ChatInputRecoveryDismissals;
};
type RecoveryInput = ReturnType<typeof getChatRecoveryInputs>[number];
type RecoveryView = { busyIds: Set<string>; dismissed: Set<string>; error?: string };
// Two panes on one connection share only presentation/action guards, never queues.
const views = new WeakMap<object, Map<string, RecoveryView>>();
const pendingScopes = new WeakMap<
  NonNullable<ReturnType<typeof getChatPendingInputs>>,
  { key: string; revision: number }
>();

function scopeKey(host: ChatInputRecoveryHost): string | undefined {
  // Read-only presentation may retain this client's previously authenticated
  // owner during reconnect. Send separately requires current recovery admission.
  const owner =
    observeOutboxRecoveryOwner(host) ??
    observeOutboxRecoveryOwner({ client: host.client, connected: false });
  if (!owner || !host.currentSessionId) {
    return undefined;
  }
  const viewer = resolveCurrentUserIdentity(host.hello, host.client?.instanceId, host.selfUser);
  return JSON.stringify([
    // Credential scope retains URL queries; the authenticated recovery owner
    // already distinguishes viewers without persisting query credentials here.
    gatewayOriginScope(host.settings.gatewayUrl ?? ""),
    owner,
    viewer?.identity ?? viewer?.id ?? null,
    resolveUiSelectedSessionAgentId(host),
    host.sessionKey,
    host.currentSessionId,
    host.selectedChatSessionIncognito === true,
  ]);
}

function viewFor(host: ChatInputRecoveryHost, key: string): RecoveryView {
  const owner = host.client ?? host;
  let scopes = views.get(owner);
  if (!scopes) {
    scopes = new Map();
    views.set(owner, scopes);
  }
  let view = scopes.get(key);
  if (!view) {
    view = { busyIds: new Set(), dismissed: new Set() };
    scopes.set(key, view);
  }
  return view;
}

function dismissalKey(scope: string, id: string): string {
  return JSON.stringify([scope, id]);
}

function currentInputs(host: ChatInputRecoveryHost, key: string): RecoveryInput[] {
  const pending = getChatPendingInputs(host);
  if (!pending || pending.client !== host.client) {
    return [];
  }
  const source = pendingScopes.get(pending);
  if (!source && pending.connectionEpoch !== host.connectionEpoch) {
    return [];
  }
  if (source && source.key !== key && source.revision === pending.revision) {
    return [];
  }
  pendingScopes.set(pending, { key, revision: pending.revision });
  return getChatRecoveryInputs(host);
}

export function getChatInputRecovery(host: ChatInputRecoveryHost): {
  items: RecoveryInput[];
  busyIds: ReadonlySet<string>;
  error?: string;
} {
  const key = scopeKey(host);
  if (!key) {
    return { items: [], busyIds: new Set() };
  }
  const view = viewFor(host, key);
  return {
    items: currentInputs(host, key).filter(
      (input) =>
        !view.dismissed.has(input.id) &&
        !host.chatInputRecoveryDismissals?.has(dismissalKey(key, input.id)),
    ),
    busyIds: view.busyIds,
    error: view.error,
  };
}

function dismiss(
  host: ChatInputRecoveryHost,
  view: RecoveryView,
  key: string,
  id: string,
  dismissals: ChatInputRecoveryDismissals | undefined,
): void {
  // Keep the document's decision even when preference storage fails. In particular,
  // a send whose custody transferred must never turn back into a fresh Send action.
  view.dismissed.add(id);
  try {
    if (dismissals?.add(dismissalKey(key, id)) === false) {
      view.error = t("chat.inputRecovery.dismissedStorageFailed");
    }
  } catch {
    view.error = t("chat.inputRecovery.dismissedStorageFailed");
  }
  host.requestUpdate?.();
}

export function discardChatRecoveryInput(host: ChatInputRecoveryHost, id: string): void {
  const dismissals = host.chatInputRecoveryDismissals;
  const key = scopeKey(host);
  const recovery = getChatInputRecovery(host);
  if (!key || recovery.busyIds.has(id) || !recovery.items.some((input) => input.id === id)) {
    return;
  }
  dismiss(host, viewFor(host, key), key, id, dismissals);
}

function inactiveOwnedInput(host: ChatInputRecoveryHost, input: RecoveryInput) {
  return input.runId ? host.chatQueue.find((item) => item.sendRunId === input.runId) : undefined;
}

function canRetry(item: ChatQueueItem, host: ChatInputRecoveryHost): boolean {
  return (
    !item.pendingRunId &&
    !item.localCommandName &&
    !item.intent &&
    (!item.sessionId || item.sessionId === host.currentSessionId) &&
    (item.sendState === "failed" || item.sendState === "held")
  );
}

function ordinaryText(text: string): boolean {
  return !/^[\s]*[!/]/u.test(text) && !isChatStopCommand(text);
}

/** Full-message display omits media bytes. Only the existing outbox can retry those. */
function readPayload(message: unknown): string | null {
  const row = asOptionalRecord(message);
  const metadata = asOptionalRecord(row?.["__openclaw"]);
  if (
    (row?.role !== "user" && row?.role !== "assistant") ||
    // The display sanitizer publishes truncated:true plus reason:"display-cap";
    // the history budget publishes reason:"oversized". Treat either reason, and
    // malformed truncation flags, as incomplete; literal sentinel text is not proof.
    (metadata?.truncated !== undefined && metadata.truncated !== false) ||
    metadata?.reason === "display-cap" ||
    metadata?.reason === "oversized" ||
    row.media != null ||
    metadata?.media != null ||
    row.attachments != null ||
    row.openclawDelivery != null ||
    row.replyToId != null ||
    metadata?.replyToId != null ||
    row.mentions != null ||
    metadata?.mentions != null ||
    metadata?.humanMentions != null ||
    row.workContext != null ||
    metadata?.workContext != null
  ) {
    return null;
  }
  const parts: string[] = [];
  const content =
    typeof row.content === "string" ? [{ type: "text", text: row.content }] : row.content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const value of content) {
    const block = asOptionalRecord(value);
    if (block?.type !== "text" || typeof block.text !== "string" || block.omitted === true) {
      return null;
    }
    parts.push(block.text);
  }
  const text = parts.join("\n");
  return text.trim() && ordinaryText(text) ? text : null;
}

export async function sendChatRecoveryInput(
  host: ChatInputRecoveryHost,
  id: string,
): Promise<void> {
  // A pane can acquire a new preference adapter while a normal send is settling.
  // Its admission callback must retain the Gateway/incognito owner selected here.
  const dismissals = host.chatInputRecoveryDismissals;
  const incognito = host.selectedChatSessionIncognito;
  const gatewayUrl = host.settings.gatewayUrl;
  const key = scopeKey(host);
  const recovery = getChatInputRecovery(host);
  const input = recovery.items.find((item) => item.id === id);
  if (!key || !input || recovery.busyIds.has(id)) {
    return;
  }
  const view = viewFor(host, key);
  const client = host.client;
  const epoch = host.connectionEpoch;
  const isCurrent = () =>
    host.connected &&
    host.client === client &&
    host.connectionEpoch === epoch &&
    host.selectedChatSessionIncognito === incognito &&
    host.settings.gatewayUrl === gatewayUrl &&
    Boolean(observeOutboxRecoveryOwner(host)) &&
    scopeKey(host) === key;
  const pending = getChatPendingInputs(host);
  if (!client || !isCurrent() || pending?.connectionEpoch !== epoch) {
    view.error = t("chat.inputRecovery.readFailed");
    host.requestUpdate?.();
    return;
  }
  view.error = undefined;
  view.busyIds.add(id);
  host.requestUpdate?.();
  let admitted = false;
  try {
    const owned = inactiveOwnedInput(host, input);
    if (owned) {
      if (!canRetry(owned, host) || !ordinaryText(owned.text)) {
        view.error = t("chat.inputRecovery.cannotSend");
        return;
      }
      // The existing outbox owns payload hydration, identity, uncertainty and retry.
      // Never copy a saved record into chatQueue to make this API accept it.
      await retryQueuedChatMessage(host, owned.id, isCurrent);
      if (!isCurrent()) {
        return;
      }
      const remaining = readQueuedMessageById(host, owned.id);
      if (
        !remaining ||
        remaining.sendRunId !== owned.sendRunId ||
        remaining.sendState !== owned.sendState
      ) {
        dismiss(host, view, key, id, dismissals);
      } else {
        view.error = host.chatError ?? host.lastError ?? t("chat.inputRecovery.cannotSend");
      }
      return;
    }
    const result = await client.request<ChatMessageGetResult>("chat.message.get", {
      sessionKey: host.sessionKey,
      agentId: resolveUiSelectedSessionAgentId(host),
      messageId: `${CHAT_PENDING_INPUT_MESSAGE_PREFIX}${id}`,
      maxChars: 2_000_000,
    });
    const currentInput = getChatInputRecovery(host).items.find((item) => item.id === id);
    if (
      !isCurrent() ||
      !currentInput ||
      currentInput.runId !== input.runId ||
      currentInput.acceptedAt !== input.acceptedAt ||
      currentInput.state !== input.state
    ) {
      return;
    }
    // A local owner may have appeared while the read was in flight. Do not create
    // a second delivery: leave its next explicit retry to the outbox.
    if (inactiveOwnedInput(host, input)) {
      view.error = t("chat.inputRecovery.cannotSend");
      return;
    }
    const payload =
      result.ok &&
      resolveSourceMessageId(result.message) === `${CHAT_PENDING_INPUT_MESSAGE_PREFIX}${id}`
        ? readPayload(result.message)
        : null;
    if (!payload) {
      view.error = t("chat.inputRecovery.cannotSend");
      return;
    }
    await handleSendChat(host, payload, {
      attachmentsOverride: [],
      replyTargetOverride: null,
      // Omit mode overrides: this explicit submission follows normal Send policy.
      onOutboxAdmitted: () => {
        admitted = true;
        dismiss(host, view, key, id, dismissals);
      },
    });
    if (!admitted && isCurrent()) {
      view.error = host.chatError ?? host.lastError ?? t("chat.inputRecovery.cannotSend");
    }
  } catch {
    if (isCurrent() && !admitted) {
      view.error = t("chat.inputRecovery.readFailed");
    }
  } finally {
    view.busyIds.delete(id);
    if (isCurrent()) {
      host.requestUpdate?.();
    }
  }
}
