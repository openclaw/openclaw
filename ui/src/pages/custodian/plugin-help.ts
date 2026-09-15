import {
  normalizeSystemAgentPluginReference,
  type SystemAgentPluginReference,
} from "@openclaw/gateway-protocol/system-agent-context";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ApplicationContext } from "../../app/context.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import { showToast } from "../../lib/toast.ts";
import { CustodianSessionOwner } from "./custodian-session-identity.ts";

export type PluginHelpReference = Pick<SystemAgentPluginReference, "id" | "name">;
export type PluginHelpSetting = {
  /** Structural path from the configuration owner, including dynamic keys. */
  path: Array<string | number>;
  label: string;
  value: unknown;
  /** The canonical hasSensitiveConfigData result, including nested hints/schema. */
  sensitive: boolean;
};

type PluginHelpContext = Pick<ApplicationContext, "gateway" | "router">;

type Publication = {
  owner: object;
  reference: SystemAgentPluginReference;
  pathname: string;
  overview: boolean;
  installed: boolean;
};
type HelpState = {
  identity: CustodianSessionOwner;
  scope: string;
  publication?: Publication;
  pendingDraft: string;
  focusRequest: number;
  selectionEpoch: number;
  seenGateways: Set<string>;
  listeners: Set<() => void>;
};
const states = new WeakMap<PluginHelpContext, HelpState>();

function stateFor(context: PluginHelpContext): HelpState {
  let state = states.get(context);
  if (!state) {
    const identity = new CustodianSessionOwner();
    state = {
      identity,
      scope: identity.key(context.gateway),
      pendingDraft: "",
      focusRequest: 0,
      selectionEpoch: 0,
      seenGateways: new Set(),
      listeners: new Set(),
    };
    states.set(context, state);
    const owned = state;
    context.gateway.subscribe(() => {
      synchronize(context, owned);
      notify(owned);
    });
    context.router.subscribe(() => {
      if (owned.publication && owned.publication.pathname !== pathname(context)) {
        owned.publication = undefined;
        owned.selectionEpoch += 1;
        notify(owned);
      }
    });
  }
  synchronize(context, state);
  return state;
}

function pathname(context: PluginHelpContext): string {
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

function notify(state: HelpState): void {
  for (const listener of state.listeners) {
    listener();
  }
}

export function subscribePluginHelp(context: PluginHelpContext, listener: () => void): () => void {
  const state = stateFor(context);
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

/** Publish only the current loaded detail; the returned release owns this exact publication. */
export function publishPluginHelpContext(
  context: PluginHelpContext,
  owner: object,
  plugin: PluginHelpReference,
  options: { overview: boolean; installed: boolean },
): () => void {
  const state = stateFor(context);
  const reference = normalizeSystemAgentPluginReference({
    ...plugin,
    installed: options.installed,
    name: truncateUtf16Safe(plugin.name, 96),
  });
  if (!reference) {
    clearPluginHelpContext(context, owner);
    return () => undefined;
  }
  const previous = state.publication;
  if (previous?.reference.id === reference.id) {
    reference.setting = previous.reference.setting;
  }
  const publication: Publication = { owner, reference, pathname: pathname(context), ...options };
  state.publication = publication;
  const changedSelection =
    previous?.owner !== owner ||
    previous.reference.id !== reference.id ||
    previous.pathname !== publication.pathname;
  if (changedSelection) {
    state.selectionEpoch += 1;
  }
  if (
    changedSelection ||
    previous?.overview !== options.overview ||
    previous?.installed !== options.installed ||
    JSON.stringify(previous?.reference) !== JSON.stringify(reference)
  ) {
    notify(state);
  }
  return () => {
    if (state.publication === publication) {
      state.publication = undefined;
      state.selectionEpoch += 1;
      notify(state);
    }
  };
}

function clearPluginHelpContext(context: PluginHelpContext, owner: object): void {
  const state = stateFor(context);
  if (state.publication?.owner === owner) {
    state.publication = undefined;
    state.selectionEpoch += 1;
    notify(state);
  }
}

export function currentPluginHelpReference(
  context: PluginHelpContext,
): SystemAgentPluginReference | undefined {
  const state = stateFor(context);
  return state.publication?.pathname === pathname(context)
    ? state.publication.reference
    : undefined;
}

/** The dock owns availability/width and calls this only when it can actually open. */
export function consumePluginHelpAutoOpen(context: PluginHelpContext): boolean {
  const state = stateFor(context);
  const url = context.gateway.connection.gatewayUrl;
  if (!state.publication?.overview || !state.publication.installed || state.seenGateways.has(url)) {
    return false;
  }
  state.seenGateways.add(url);
  return true;
}

export function dismissPluginHelpAutoOpen(context: PluginHelpContext): void {
  stateFor(context).seenGateways.add(context.gateway.connection.gatewayUrl);
}

export function createPluginHelpRequest(
  context: PluginHelpContext,
  plugin: PluginHelpReference,
): (setting?: PluginHelpSetting) => Promise<void> {
  const state = stateFor(context);
  const scope = state.scope;
  const selectionEpoch = state.selectionEpoch;
  // Capture the rendered selection before an action can outlive its page or Gateway.
  return async (setting) => {
    if (stateFor(context).scope !== scope || state.selectionEpoch !== selectionEpoch) {
      return;
    }
    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
    if (setting) {
      // Config rendering stays lazy; stale imports cannot attach a question to a
      // replacement Gateway or a newer page selection.
      let formatPluginHelpValue: typeof import("./plugin-help-value.ts").formatPluginHelpValue;
      try {
        ({ formatPluginHelpValue } = await import("./plugin-help-value.ts"));
      } catch {
        if (stateFor(context).scope === scope && state.selectionEpoch === selectionEpoch) {
          showToast({ message: t("custodian.pluginHelpFailed") });
        }
        return;
      }
      if (stateFor(context).scope !== scope || state.selectionEpoch !== selectionEpoch) {
        return;
      }
      const value = formatPluginHelpValue(setting.value, setting.sensitive);
      const question = t("custodian.pluginHelpQuestion", {
        setting: truncateUtf16Safe(setting.label, 96),
        plugin: truncateUtf16Safe(plugin.name, 96),
      });
      const draft = `${question}\n\n${t("custodian.pluginHelpValue", { value })}`;
      state.pendingDraft = [state.pendingDraft, draft].filter(Boolean).join("\n\n");
      const publication = state.publication;
      if (publication?.reference.id === plugin.id) {
        publication.reference =
          normalizeSystemAgentPluginReference({
            ...publication.reference,
            setting: {
              path: setting.path.map(String),
              label: truncateUtf16Safe(setting.label, 96),
            },
          }) ?? publication.reference;
      }
    }
    state.focusRequest += 1;
    notify(state);
  };
}

export function pendingPluginHelpDraft(context: PluginHelpContext): boolean {
  return Boolean(stateFor(context).pendingDraft);
}

export function takePluginHelpDraft(context: PluginHelpContext): string {
  const state = stateFor(context);
  const draft = state.pendingDraft;
  state.pendingDraft = "";
  return draft;
}

export function pluginHelpFocusRequest(context: PluginHelpContext): number {
  return stateFor(context).focusRequest;
}
