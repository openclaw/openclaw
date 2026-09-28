import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type { ChatMessageGetResult } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { t } from "../../i18n/index.ts";
import { registerChatInputRecoveryEnglish } from "../../i18n/locales/en-chat-input-recovery.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { observeOutboxRecoveryOwner } from "../../lib/chat/outbox-payload-store.runtime.ts";
import { senderIdentityKey } from "../../lib/chat/sender-label.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import {
  isChatRecoveryInputSendable,
  type ChatInputRecoveryDismissals,
} from "./chat-input-recovery-contract.ts";
import {
  resolveSourceMessageId,
  type AssistantMessageExpansionState,
} from "./chat-message-recovery.ts";
import {
  getChatPendingInputs,
  getChatRecoveryInputs,
  hasLiveChatInputCustody,
} from "./chat-pending-inputs.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { isChatStopCommand } from "./run-lifecycle.ts";

registerChatInputRecoveryEnglish();

export type ChatInputRecoveryHost = ChatHost & {
  chatInputRecoveryDismissals?: ChatInputRecoveryDismissals;
};
type RecoveryInput = ReturnType<typeof getChatRecoveryInputs>[number];
type RecoveryView = { busyIds: Set<string>; dismissed: Set<string>; error?: string };
type RecoveryInspection = {
  expandedIds: Set<string>;
  inspections: Map<string, AssistantMessageExpansionState>;
  inspectionInputs: Map<string, RecoveryInput>;
  inspectionRevision: number;
  inspectionEpoch: number;
};
// Two panes on one connection share only presentation/action guards, never queues.
const views = new WeakMap<object, Map<string, RecoveryView>>();
// Disclosure payloads belong to the pane; a long-lived client must not retain them
// after teardown or open another pane’s row as a side effect. Send guards stay shared.
const inspectionViews = new WeakMap<
  ChatInputRecoveryHost,
  { key: string; view: RecoveryInspection }
>();
const pendingScopes = new WeakMap<
  NonNullable<ReturnType<typeof getChatPendingInputs>>,
  {
    key: string;
    revision: number;
    viewer: string | null;
    page: NonNullable<ReturnType<typeof getChatPendingInputs>>["page"];
  }
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
  const pending = getChatPendingInputs(host);
  const previous =
    pending && pending.client === host.client ? pendingScopes.get(pending) : undefined;
  // Disconnect clears hello/selfUser. Only a page already bound on this client
  // may keep its viewer; never infer a new presentation scope while offline.
  if (!host.connected && !previous) {
    return undefined;
  }
  const viewer = host.connected ? currentViewer(host) : (previous?.viewer ?? null);
  return JSON.stringify([
    // Credential scope retains URL queries; the authenticated recovery owner
    // already distinguishes viewers without persisting query credentials here.
    gatewayOriginScope(host.settings.gatewayUrl ?? ""),
    owner,
    viewer,
    resolveUiSelectedSessionAgentId(host),
    host.sessionKey,
    host.currentSessionId,
    host.selectedChatSessionIncognito === true,
  ]);
}

function currentViewer(host: ChatInputRecoveryHost): string | null {
  const viewer = resolveCurrentUserIdentity(host.hello, host.client?.instanceId, host.selfUser);
  return viewer?.identity ? senderIdentityKey(viewer) : (viewer?.id ?? null);
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

function inspectionFor(host: ChatInputRecoveryHost, key: string): RecoveryInspection {
  const current = inspectionViews.get(host);
  if (current?.key === key && current.view.inspectionEpoch === host.connectionEpoch) {
    return current.view;
  }
  const view: RecoveryInspection = {
    expandedIds: new Set(),
    inspections: new Map(),
    inspectionInputs: new Map(),
    inspectionRevision: 0,
    inspectionEpoch: host.connectionEpoch,
  };
  inspectionViews.set(host, { key, view });
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
  if (
    source &&
    source.key !== key &&
    (!host.connected ||
      pending.connectionEpoch !== host.connectionEpoch ||
      source.page === pending.page)
  ) {
    return [];
  }
  pendingScopes.set(pending, {
    key,
    revision: pending.revision,
    page: pending.page,
    viewer: host.connected ? currentViewer(host) : (source?.viewer ?? null),
  });
  return getChatRecoveryInputs(host);
}

function sameRecoveryInput(left: RecoveryInput, right: RecoveryInput): boolean {
  return (
    left.id === right.id &&
    left.runId === right.runId &&
    left.acceptedAt === right.acceptedAt &&
    left.state === right.state
  );
}

function retireInspection(view: RecoveryInspection, id: string): void {
  view.expandedIds.delete(id);
  view.inspections.delete(id);
  view.inspectionInputs.delete(id);
}

export function getChatInputRecovery(host: ChatInputRecoveryHost): {
  items: RecoveryInput[];
  busyIds: ReadonlySet<string>;
  expandedIds: ReadonlySet<string>;
  inspections: ReadonlyMap<string, AssistantMessageExpansionState>;
  error?: string;
} {
  const key = scopeKey(host);
  if (!key) {
    return { items: [], busyIds: new Set(), expandedIds: new Set(), inspections: new Map() };
  }
  const view = viewFor(host, key);
  const inputs = currentInputs(host, key);
  retireLocallyOwnedPresentations(host, view, key);
  const items = inputs.filter(
    (input) =>
      !view.dismissed.has(input.id) &&
      !host.chatInputRecoveryDismissals?.has(dismissalKey(key, input.id)),
  );
  const inspection = inspectionFor(host, key);
  for (const [id, source] of inspection.inspectionInputs) {
    if (!items.some((input) => sameRecoveryInput(input, source))) {
      retireInspection(inspection, id);
    }
  }
  return {
    items,
    busyIds: view.busyIds,
    expandedIds: inspection.expandedIds,
    inspections: inspection.inspections,
    error: view.error,
  };
}

function retireLocallyOwnedPresentations(
  host: ChatInputRecoveryHost,
  view: RecoveryView,
  key: string,
): void {
  const dismissals = host.chatInputRecoveryDismissals;
  const pending = getChatPendingInputs(host);
  const source = pending && pendingScopes.get(pending);
  if (
    !dismissals ||
    !host.connected ||
    host.canRestoreComposer?.() === false ||
    !observeOutboxRecoveryOwner(host) ||
    !pending ||
    pending.client !== host.client ||
    pending.connectionEpoch !== host.connectionEpoch ||
    source?.key !== key ||
    source.revision !== pending.revision ||
    source.page !== pending.page
  ) {
    return;
  }
  // The shared custody projection leaves this payload with native Retry/Discard.
  // Retire only its duplicate saved presentation before native Retry can rotate
  // the run ID. This never alters the queue, payload, or Gateway custody.
  for (const input of pending.page.items) {
    if (
      input.state !== "interrupted" ||
      input.queued ||
      hasLiveChatInputCustody(host, input) ||
      view.dismissed.has(input.id) ||
      dismissals.has(dismissalKey(key, input.id))
    ) {
      continue;
    }
    const owned = localInputOwner(host, input);
    if (
      owned &&
      (!owned.sessionId || owned.sessionId === host.currentSessionId) &&
      (owned.sendState === "held" || owned.sendState === "failed")
    ) {
      dismiss(host, view, key, input.id, dismissals);
    }
  }
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
  retireInspection(inspectionFor(host, key), id);
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

function cappedInputMessage(message: unknown): boolean {
  const row = asOptionalRecord(message);
  const metadata = asOptionalRecord(row?.["__openclaw"]);
  return (
    metadata?.truncated === true ||
    metadata?.reason === "display-cap" ||
    metadata?.reason === "oversized"
  );
}

/** Explicit, read-only disclosure. Closing retires its token, not Gateway custody. */
export async function toggleChatRecoveryInput(
  host: ChatInputRecoveryHost,
  id: string,
  open: boolean,
): Promise<void> {
  const key = scopeKey(host);
  const recovery = getChatInputRecovery(host);
  const input = recovery.items.find((item) => item.id === id);
  if (!key || !input) {
    return;
  }
  const view = inspectionFor(host, key);
  if (!open) {
    retireInspection(view, id);
    host.requestUpdate?.();
    return;
  }
  // The renderer calls this for actual open changes or an explicit Retry click,
  // never during render. Keep loading/loaded opens inert; only errors may retry.
  if (view.expandedIds.has(id) && view.inspections.get(id)?.status !== "error") {
    return;
  }
  view.expandedIds.add(id);
  view.inspectionInputs.set(id, input);
  host.requestUpdate?.();
  if (!cappedInputMessage(input.message)) {
    return;
  }
  const client = host.client;
  const epoch = host.connectionEpoch;
  const gatewayUrl = host.settings.gatewayUrl;
  const isCurrent = () =>
    host.canRestoreComposer?.() !== false &&
    host.connected &&
    host.client === client &&
    host.connectionEpoch === epoch &&
    host.settings.gatewayUrl === gatewayUrl &&
    Boolean(observeOutboxRecoveryOwner(host)) &&
    scopeKey(host) === key;
  const revision = ++view.inspectionRevision;
  if (!client || !isCurrent() || getChatPendingInputs(host)?.connectionEpoch !== epoch) {
    view.inspections.set(id, { status: "error", revision });
    host.requestUpdate?.();
    return;
  }
  const loading: AssistantMessageExpansionState = { status: "loading", revision };
  view.inspections.set(id, loading);
  host.requestUpdate?.();
  const acceptsResult = () => {
    const current = getChatInputRecovery(host).items.find((item) => item.id === id);
    return (
      isCurrent() &&
      view.expandedIds.has(id) &&
      view.inspections.get(id) === loading &&
      current !== undefined &&
      sameRecoveryInput(current, input)
    );
  };
  try {
    const result = await client.request<ChatMessageGetResult>("chat.message.get", {
      sessionKey: host.sessionKey,
      agentId: resolveUiSelectedSessionAgentId(host),
      messageId: `${CHAT_PENDING_INPUT_MESSAGE_PREFIX}${id}`,
      maxChars: 2_000_000,
    });
    if (!acceptsResult()) {
      return;
    }
    view.inspections.set(
      id,
      result.ok &&
        resolveSourceMessageId(result.message) === `${CHAT_PENDING_INPUT_MESSAGE_PREFIX}${id}` &&
        !cappedInputMessage(result.message)
        ? {
            status: "loaded",
            message: result.message,
            markdown: extractText(result.message) ?? "",
            revision,
          }
        : { status: "error", revision },
    );
  } catch {
    if (acceptsResult()) {
      view.inspections.set(id, { status: "error", revision });
    }
  } finally {
    // An old pane may disappear without another render. Do not leave its loader
    // behind, and do not retire a newer pane's replacement request token.
    if (view.inspections.get(id) === loading) {
      retireInspection(view, id);
    }
    if (isCurrent()) {
      host.requestUpdate?.();
    }
  }
}

function localInputOwner(host: ChatInputRecoveryHost, input: RecoveryInput) {
  return input.runId ? host.chatQueue.find((item) => item.sendRunId === input.runId) : undefined;
}

function ordinaryText(text: string): boolean {
  return !/^[\s]*[!/]/u.test(text) && !isChatStopCommand(text);
}

/** Full-message display omits media bytes. Only the existing outbox can retry those. */
function readPayload(message: unknown): string | null {
  const row = asOptionalRecord(message);
  const metadata = asOptionalRecord(row?.["__openclaw"]);
  if (
    !row ||
    !isChatRecoveryInputSendable(row) ||
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
    host.canRestoreComposer?.() !== false &&
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
  if (!isChatRecoveryInputSendable(input.message)) {
    view.error = t("chat.inputRecovery.cannotSend");
    host.requestUpdate?.();
    return;
  }
  view.error = undefined;
  view.busyIds.add(id);
  host.requestUpdate?.();
  let admitted = false;
  try {
    if (localInputOwner(host, input)) {
      view.error = t("chat.inputRecovery.cannotSend");
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
      !sameRecoveryInput(currentInput, input) ||
      !isChatRecoveryInputSendable(currentInput.message)
    ) {
      return;
    }
    // A local owner may have appeared while the read was in flight. Do not create
    // a second delivery: leave its next explicit retry to the outbox.
    if (localInputOwner(host, input)) {
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
