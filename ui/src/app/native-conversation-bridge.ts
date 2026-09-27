/**
 * Canonical native conversation contract, mirrored by the macOS host.
 * Document-start globals: __OPENCLAW_NATIVE_EMBED__.surface = "conversation"
 * and __OPENCLAW_NATIVE_CONVERSATION__ = {contract:1}.
 * WebKit openclawConversation.postMessage receives the flat messages below and
 * replies with {ok:true} or {ok:false,error}. ready is always the first message.
 * The host probes __OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__ before adopting ready
 * and retires that binding on every committed navigation or process termination.
 * Commands arrive as openclaw:native-conversation-command CustomEvent.detail.
 * Every requestId receives one command-result; document mismatches fail closed.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { RouteLocation } from "@openclaw/uirouter";
import { z } from "zod";
import { routeIdFromPath } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { anchorFromNavigationEvent, shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { isSessionRunActive } from "../lib/session-run-state.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  resolveUiSelectedSessionAgentId,
  uiConversationMatches,
} from "../lib/sessions/session-key.ts";
import { showToast } from "../lib/toast.ts";
import {
  CHAT_RUN_ACTIVITY_CHANGED_EVENT,
  CHAT_PANE_LIFECYCLE_CHANGED_EVENT,
} from "../pages/chat/chat-history-events.ts";
import type { ChatPaneBase } from "../pages/chat/chat-pane-base.ts";
import type { ChatRouteData } from "../pages/chat/session-route-data.ts";
import type { ApplicationContext } from "./context.ts";
import type { NativeConversationBridge } from "./native-conversation-types.ts";
import { nativeEmbedHost } from "./native-web-chrome.ts";

const COMMAND_EVENT = "openclaw:native-conversation-command";
const RESPONSE_TIMEOUT_MS = 15_000;
const identifier = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value);
const envelope = z.object({
  contract: z.literal(1),
  documentId: identifier,
  requestId: identifier,
  type: z.string(),
  payload: z.unknown(),
});
const commandIdentity = envelope.pick({ documentId: true, requestId: true });
const navigatePayload = z.object({ agentId: identifier, sessionKey: identifier }).strict();
const presentationPayload = z.object({ visible: z.boolean(), active: z.boolean() }).strict();
const emptyPayload = z.object({}).strict();

type Conversation = {
  context: { agentId: string; sessionKey: string };
  title: string;
  run: { active: boolean };
};
type Connection = "connected" | "connecting" | "offline" | "signed-out";
type Binding = { contract: 1; documentId: string };
type Delivery = "accepted" | "rejected" | "timeout";
type NativeConversationMessage = Binding &
  (
    | { type: "ready"; surface: "conversation"; capabilities: string[] }
    | ({ type: "state"; revision: number; connection: Connection } & Conversation)
    | {
        type: "route-changed";
        agentId: string;
        sessionKey: string;
        reason: "fork" | "link" | "new" | "other";
      }
    | { type: "open-dashboard"; path: string; search?: string }
    | { type: "command-result"; requestId: string; ok: boolean; error?: string }
  );

type NativeConversationWindow = Window & {
  __OPENCLAW_NATIVE_CONVERSATION__?: unknown;
  __OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__?: Binding;
  webkit?: {
    messageHandlers?: {
      openclawConversation?: {
        postMessage: (message: NativeConversationMessage) => Promise<unknown>;
      };
    };
  };
};

export function createNativeConversationBridge(
  context: ApplicationContext,
): NativeConversationBridge | null {
  // SAFETY: document-start WebKit globals are host input, validated before use.
  const host = window as NativeConversationWindow;
  const capability = host["__OPENCLAW_NATIVE_CONVERSATION__"];
  const handler = host.webkit?.messageHandlers?.openclawConversation;
  if (
    nativeEmbedHost()?.surface !== "conversation" ||
    !isRecord(capability) ||
    capability.contract !== 1 ||
    typeof handler?.postMessage !== "function"
  ) {
    return null;
  }
  const binding: Binding = { contract: 1, documentId: crypto.randomUUID() };
  host["__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__"] = binding;
  const postMessage = handler.postMessage;
  const post = postMessage.bind(handler);
  let disposed = false;
  let presentation = { visible: true, active: true };
  let conversation: Conversation | undefined;
  let reportedRoute: Conversation["context"] | undefined;
  let lastState = "";
  let revision = 0;
  let navigating = false;
  let commands = Promise.resolve();
  let outgoing = Promise.resolve<Delivery>("accepted");
  let stateDelivery = Promise.resolve<Delivery>("rejected");
  let stateDeliveryFailed = false;
  const requests = new Set<string>();
  const listeners = new Set<() => void>();
  const pending = new Set<() => void>();
  const current = () =>
    !disposed &&
    host["__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__"] === binding &&
    host.webkit?.messageHandlers?.openclawConversation === handler &&
    handler.postMessage === postMessage;
  const bounded = <T>(
    work: (active: () => boolean) => Promise<T>,
    timeout: T,
    deadline = Date.now() + RESPONSE_TIMEOUT_MS,
  ): Promise<T> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (result: T) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        pending.delete(expire);
        resolve(result);
      };
      const expire = () => finish(timeout);
      const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
      pending.add(expire);
      void work(() => !settled && current() && Date.now() < deadline).then(finish, expire);
    });
  const postToHost = async (message: NativeConversationMessage): Promise<Delivery> => {
    if (!current()) {
      return "rejected";
    }
    try {
      const reply = await post(message);
      return current() && isRecord(reply) && reply.ok === true ? "accepted" : "rejected";
    } catch {
      return "rejected";
    }
  };
  const send = (
    message: NativeConversationMessage,
    deadline?: number,
    canSend = current,
  ): Promise<Delivery> => {
    // Readiness adoption and state publication finish before later messages reach
    // the host. Expired deliveries release the queue without retrying the message.
    const previous = outgoing;
    outgoing = bounded(
      async (active) => {
        await previous;
        return active() && canSend() ? postToHost(message) : "timeout";
      },
      "timeout",
      deadline,
    );
    return outgoing;
  };
  const publishState = (deadline?: number, active?: () => boolean) => {
    if (!conversation || !current()) {
      return Promise.resolve<Delivery>("rejected");
    }
    const { phase, lastErrorAuthReason } = context.gateway.snapshot;
    const connection: Connection =
      phase === "connected"
        ? "connected"
        : lastErrorAuthReason
          ? "signed-out"
          : phase === "connecting" || phase === "starting" || phase === "reconnecting"
            ? "connecting"
            : "offline";
    const snapshot = { ...conversation, connection };
    const serialized = JSON.stringify(snapshot);
    // A fresh command can confirm a failed delivery; passive refresh stays
    // change-only so a lost acknowledgement never creates a retry loop.
    if (serialized !== lastState || (active && stateDeliveryFailed)) {
      lastState = serialized;
      stateDeliveryFailed = false;
      const delivery = send(
        { ...binding, type: "state", revision: ++revision, ...snapshot },
        deadline,
        active,
      );
      stateDelivery = delivery;
      void delivery.then((result) => {
        if (stateDelivery === delivery) {
          stateDeliveryFailed = result !== "accepted";
        }
      });
    }
    return stateDelivery;
  };
  const refreshConversation = () => {
    const route = context.router.getState();
    const match = route.matches[0];
    // SAFETY: only the chat route produces ChatRouteData; pending loaders cannot publish an owner.
    const data = match?.routeId === "chat" ? (match.data as ChatRouteData | undefined) : undefined;
    if (match?.status === "success" && data?.kind === "session") {
      const sessionKey = data.sessionKey;
      const defaults = {
        agentsList: context.agents.state.agentsList,
        hello: context.gateway.snapshot.hello,
        assistantAgentId: data.agentId ?? context.gateway.snapshot.assistantAgentId,
      };
      const agentId = resolveUiSelectedSessionAgentId(defaults, sessionKey);
      if (!agentId) {
        return;
      }
      const roster = context.sessions.presentation;
      const row = roster.result?.sessions.find((candidate) =>
        uiConversationMatches(
          defaults,
          sessionKey,
          candidate.key,
          candidate.agentId ?? (isUiGlobalSessionKey(candidate.key) ? roster.agentId : undefined),
          agentId,
        ),
      );
      const pane = [
        ...document.querySelectorAll<ChatPaneBase>("openclaw-chat-page openclaw-chat-pane"),
      ].find((candidate) => areUiSessionKeysEquivalent(candidate.sessionKey, sessionKey));
      const activity = pane?.runActivity;
      const paneActive =
        activity?.client === context.gateway.snapshot.client && activity?.agentId === agentId
          ? activity.working
          : false;
      conversation = {
        context: { agentId, sessionKey },
        title: resolveSessionDisplayName(sessionKey, row),
        run: { active: paneActive || (row ? isSessionRunActive(row) : false) },
      };
    }
    // Keep the last settled owner through pending loaders so web navigation
    // still reports its transition when the next conversation becomes ready.
    if (!navigating && conversation) {
      const next = conversation.context;
      if (
        reportedRoute &&
        (reportedRoute.agentId !== next.agentId || reportedRoute.sessionKey !== next.sessionKey)
      ) {
        void send({ ...binding, type: "route-changed", ...next, reason: "other" });
      }
      reportedRoute = next;
      void publishState();
    }
  };
  const interceptNavigation = (location: RouteLocation) => {
    const routeId = routeIdFromPath(location.pathname, context.basePath);
    if (!routeId || routeId === "chat") {
      return false;
    }
    void send({
      ...binding,
      type: "open-dashboard",
      path: location.pathname,
      ...(location.search ? { search: location.search } : {}),
    }).then((delivery) => {
      if (delivery !== "accepted" && current()) {
        showToast({ message: t("nativeConversation.openDashboardFailed") });
      }
    });
    return true;
  };
  const execute = async (
    detail: unknown,
    active: () => boolean,
    deadline: number,
  ): Promise<string | undefined> => {
    const parsed = envelope.safeParse(detail);
    if (!parsed.success) {
      return isRecord(detail) && detail.contract !== 1 ? "unsupported" : "invalid-command";
    }
    const command = parsed.data;
    if (command.documentId !== binding.documentId || !current()) {
      return "stale-document";
    }
    switch (command.type) {
      case "navigate": {
        const target = navigatePayload.safeParse(command.payload);
        if (!target.success) {
          return "invalid-command";
        }
        const options = sessionNavigationTarget({
          context,
          face: "chat",
          exactKey: true,
          ...target.data,
        }).options;
        navigating = true;
        try {
          await context.navigateAndWait("chat", options);
        } catch {
          return "navigate-rejected";
        }
        if (!active()) {
          return "navigate-timeout";
        }
        refreshConversation();
        const targetSelected = () => {
          const route = context.router.getState();
          return (
            route.pendingMatches.length === 0 &&
            route.matches[0]?.routeId === "chat" &&
            route.matches[0]?.status === "success" &&
            isRecord(route.matches[0]?.data) &&
            route.matches[0].data.kind === "session" &&
            conversation &&
            uiConversationMatches(
              {
                agentsList: context.agents.state.agentsList,
                hello: context.gateway.snapshot.hello,
              },
              conversation.context.sessionKey,
              target.data.sessionKey,
              target.data.agentId,
              conversation.context.agentId,
            )
          );
        };
        // A fulfilled router promise can mean cancellation, a missing session,
        // or superseding navigation. Only the settled target can acknowledge success.
        if (!targetSelected()) {
          return "navigate-rejected";
        }
        // The host requested this settled route. Preserve later web selections
        // independently, including while its state acknowledgement is pending.
        reportedRoute = conversation?.context;
        const published = await publishState(deadline, active);
        if (!active() || published === "timeout") {
          return "navigate-timeout";
        }
        return published === "accepted" && targetSelected() ? undefined : "navigate-rejected";
      }
      case "presentation": {
        const next = presentationPayload.safeParse(command.payload);
        if (!next.success) {
          return "invalid-command";
        }
        presentation = next.data;
        listeners.forEach((listener) => listener());
        return undefined;
      }
      case "focus-composer": {
        if (!emptyPayload.safeParse(command.payload).success) {
          return "invalid-command";
        }
        const composer = document.querySelector<HTMLTextAreaElement>(
          "openclaw-chat-pane.chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
        );
        if (!presentation.visible || !presentation.active || !composer || composer.disabled) {
          return "unavailable";
        }
        composer.focus({ preventScroll: true });
        return undefined;
      }
      default:
        return "unsupported";
    }
  };
  const onCommand = (event: Event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    const identity = commandIdentity.safeParse(detail);
    if (!identity.success) {
      return; // A result requires the originating document and request binding.
    }
    const { documentId, requestId } = identity.data;
    const key = JSON.stringify([documentId, requestId]);
    if (requests.has(key)) {
      return;
    }
    requests.add(key);
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    const previous = commands;
    // The receipt deadline includes queueing; expired continuations cannot publish
    // state or take ownership from the next command after a late loader resolves.
    commands = bounded<string | undefined>(
      async (active) => {
        await previous;
        if (!active()) {
          return "navigate-timeout";
        }
        try {
          return await execute(detail, active, deadline);
        } catch {
          return "command-failed";
        }
      },
      "navigate-timeout",
      deadline,
    ).then((error) => {
      if (!current()) {
        return;
      }
      // Success already awaits accepted state. Failure must reach the host even
      // when an earlier host acknowledgement is stuck; ready was invoked first.
      void bounded(
        () =>
          postToHost({
            ...binding,
            type: "command-result",
            // A stale rejection must never collide with a current document's request.
            documentId,
            requestId,
            ok: error === undefined,
            ...(error ? { error } : {}),
          }),
        "timeout",
      );
      navigating = false;
      refreshConversation();
    });
  };
  const onClick = (event: MouseEvent) => {
    if (!shouldHandleNavigationClick(event)) {
      return;
    }
    const anchor = anchorFromNavigationEvent(event);
    if (
      !anchor?.hasAttribute("href") ||
      anchor.hasAttribute("download") ||
      anchor.hasAttribute("data-file-path") ||
      (anchor.target && anchor.target !== "_self")
    ) {
      return;
    }
    const url = new URL(anchor.href, window.location.href);
    if (
      url.origin !== window.location.origin ||
      (context.basePath && !url.pathname.startsWith(`${context.basePath}/`))
    ) {
      return;
    }
    if (interceptNavigation(url)) {
      event.preventDefault();
    }
  };
  window.addEventListener(COMMAND_EVENT, onCommand);
  document.addEventListener("click", onClick);
  void send({
    ...binding,
    type: "ready",
    surface: "conversation",
    capabilities: ["navigate", "presentation", "focus-composer"],
  });
  document.addEventListener(CHAT_RUN_ACTIVITY_CHANGED_EVENT, refreshConversation);
  document.addEventListener(CHAT_PANE_LIFECYCLE_CHANGED_EVENT, refreshConversation);
  const stopGateway = context.gateway.subscribe(refreshConversation);
  const stopRouter = context.router.subscribe(refreshConversation);
  const stopSessions = context.sessions.subscribe(refreshConversation);
  refreshConversation();
  return {
    get presentation() {
      return presentation;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    interceptNavigation,
    dispose() {
      disposed = true;
      pending.forEach((expire) => expire());
      document.removeEventListener(CHAT_RUN_ACTIVITY_CHANGED_EVENT, refreshConversation);
      document.removeEventListener(CHAT_PANE_LIFECYCLE_CHANGED_EVENT, refreshConversation);
      stopGateway();
      stopRouter();
      stopSessions();
      listeners.clear();
      window.removeEventListener(COMMAND_EVENT, onCommand);
      document.removeEventListener("click", onClick);
      if (host["__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__"] === binding) {
        delete host["__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__"];
      }
    },
  };
}
