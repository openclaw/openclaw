import type { SystemAgentPluginReference } from "@openclaw/gateway-protocol/system-agent-context";
import type { ApplicationContext } from "../../app/context.ts";
import { CustodianSessionOwner } from "./custodian-session-owner.ts";

// The dock observes shared state at startup; plugin request preparation stays
// in the lazy plugin page so opening ordinary chat does not load that work.
export type PluginHelpContext = Pick<ApplicationContext, "gateway" | "router">;

export type Publication = {
  owner: object;
  reference: SystemAgentPluginReference;
  pathname: string;
};
type HelpState = {
  identity: CustodianSessionOwner;
  scope: string;
  publication?: Publication;
  pendingDraft: string;
  focusRequest: number;
  selectionEpoch: number;
  listeners: Set<() => void>;
};
const states = new WeakMap<PluginHelpContext, HelpState>();

export function pluginHelpState(context: PluginHelpContext): HelpState {
  let state = states.get(context);
  if (!state) {
    const identity = new CustodianSessionOwner();
    state = {
      identity,
      scope: identity.key(context.gateway),
      pendingDraft: "",
      focusRequest: 0,
      selectionEpoch: 0,
      listeners: new Set(),
    };
    states.set(context, state);
    const owned = state;
    // Gateway receipts retire scoped publications and drafts before pending help requests can complete.
    context.gateway.subscribe(() => {
      synchronize(context, owned);
      notifyPluginHelp(owned);
    });
    // Navigation immediately retires the publication epoch used by pending help requests.
    context.router.subscribe(() => {
      if (owned.publication && owned.publication.pathname !== pluginHelpPathname(context)) {
        owned.publication = undefined;
        owned.selectionEpoch += 1;
        notifyPluginHelp(owned);
      }
    });
  }
  synchronize(context, state);
  return state;
}

export function pluginHelpPathname(context: PluginHelpContext): string {
  return context.router.getState().location?.pathname ?? window.location.pathname;
}

function synchronize(context: PluginHelpContext, state: HelpState): void {
  const scope = state.identity.key(context.gateway);
  if (state.scope !== scope) {
    state.scope = scope;
    state.publication = undefined;
    state.selectionEpoch += 1;
    state.pendingDraft = "";
    state.focusRequest = 0;
  }
}

export function notifyPluginHelp(state: HelpState): void {
  state.listeners.forEach((listener) => listener());
}

export function subscribePluginHelp(context: PluginHelpContext, listener: () => void): () => void {
  const state = pluginHelpState(context);
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}
