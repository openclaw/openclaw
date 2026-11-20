import { createChangeListeners } from "../../../src/shared/listeners.js";
import { HOME_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import { selectedHomeTarget } from "../lib/sessions/home-session.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { chatInputOwnerForContext } from "./chat-input-owner.ts";
import type { ApplicationContext } from "./context.ts";
import { isNativeEmbedHost } from "./native-web-chrome.ts";

export function captureHomeHelpTarget(context: ApplicationContext) {
  const target = selectedHomeTarget(context);
  const { client, selfUser, hello } = context.gateway.snapshot;
  const connectionRevision = context.gateway.connectionRevision;
  const selectionRevision = context.agentSelection.intentRevision;
  const selectedId = context.agentSelection.state.selectedId;
  const recoveryScope = hello?.auth?.recoveryScope;
  return {
    ...target,
    isCurrent: () => {
      const snapshot = context.gateway.snapshot;
      const current = selectedHomeTarget(context);
      return (
        snapshot.client === client &&
        snapshot.selfUser?.id === selfUser?.id &&
        snapshot.hello?.auth?.recoveryScope === recoveryScope &&
        context.gateway.connectionRevision === connectionRevision &&
        context.agentSelection.intentRevision === selectionRevision &&
        context.agentSelection.state.selectedId === selectedId &&
        current.agentId === target.agentId &&
        current.sessionKey === target.sessionKey
      );
    },
  };
}

type Target = ReturnType<typeof captureHomeHelpTarget>;
type HelpDraft = { target: Target; text: string };
type Handoff = { pending?: HelpDraft; listeners: ReturnType<typeof createChangeListeners> };
const handoffs = new WeakMap<ApplicationContext, Handoff>();
function handoff(context: ApplicationContext): Handoff {
  let owner = handoffs.get(context);
  if (!owner) {
    owner = { listeners: createChangeListeners() };
    handoffs.set(context, owner);
  }
  return owner;
}

/** One unsent handoff; the ordinary composer owns editing, persistence and send admission. */
export function openHomeHelp(context: ApplicationContext, target: Target, text: string): void {
  if (!target.isCurrent()) {
    return;
  }
  const owner = handoff(context);
  owner.pending = { target, text };
  if (isNativeEmbedHost()) {
    // Embedded Settings has no assistant dock. Keep the handoff in this
    // authenticated WebView and open its ordinary, visible chat route.
    chatInputOwnerForContext(context).claim("page");
    context.navigate(
      "chat",
      sessionNavigationTarget({ context, face: "chat", ...target, focusComposer: true }).options,
    );
  } else {
    window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
  }
  owner.listeners.publish();
}

export function subscribeHomeHelp(context: ApplicationContext, listener: () => void): () => void {
  return handoff(context).listeners.subscribe(listener);
}

export function takeHomeHelpDraft(
  context: ApplicationContext,
  target: { agentId?: string; sessionKey: string },
): string | undefined {
  const owner = handoff(context);
  const pending = owner.pending;
  if (!pending) {
    return undefined;
  }
  if (!pending.target.isCurrent()) {
    owner.pending = undefined;
    return undefined;
  }
  if (
    pending.target.agentId !== target.agentId ||
    pending.target.sessionKey !== target.sessionKey
  ) {
    return undefined;
  }
  owner.pending = undefined;
  return pending.text;
}
