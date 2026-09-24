import {
  normalizeSystemAgentPluginReference,
  type SystemAgentPluginReference,
} from "@openclaw/gateway-protocol/system-agent-context";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { showToast } from "../../lib/toast.ts";
import {
  pluginHelpState,
  pluginHelpPathname,
  notifyPluginHelp,
  type PluginHelpContext,
  type Publication,
} from "./plugin-help-state.ts";

registerPluginManagementEnglish();

export type PluginHelpReference = Pick<SystemAgentPluginReference, "id" | "name" | "declared">;
export type PluginHelpSetting = {
  /** Structural path from the configuration owner, including dynamic keys. */
  path: Array<string | number>;
  label: string;
  value: unknown;
  /** The canonical hasSensitiveConfigData result, including nested hints/schema. */
  sensitive: boolean;
};

/** Publish only the current loaded detail; the returned release owns this exact publication. */
export function publishPluginHelpContext(
  context: PluginHelpContext,
  owner: object,
  plugin: PluginHelpReference,
  options: { overview: boolean; installed: boolean },
): () => void {
  const state = pluginHelpState(context);
  const previous = state.publication;
  const reference = normalizeSystemAgentPluginReference({
    ...plugin,
    installed: options.installed,
    name: truncateUtf16Safe(plugin.name, 96),
    setting: previous?.reference.id === plugin.id ? previous.reference.setting : undefined,
  });
  if (!reference) {
    clearPluginHelpContext(context, owner);
    return () => undefined;
  }
  const publication: Publication = {
    owner,
    reference,
    pathname: pluginHelpPathname(context),
    ...options,
  };
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
    notifyPluginHelp(state);
  }
  return () => {
    if (state.publication === publication) {
      state.publication = undefined;
      state.selectionEpoch += 1;
      notifyPluginHelp(state);
    }
  };
}

function clearPluginHelpContext(context: PluginHelpContext, owner: object): void {
  const state = pluginHelpState(context);
  if (state.publication?.owner === owner) {
    state.publication = undefined;
    state.selectionEpoch += 1;
    notifyPluginHelp(state);
  }
}

export function createPluginHelpRequest(
  context: PluginHelpContext,
  plugin: PluginHelpReference,
): (intent?: PluginHelpSetting | { question: string }) => Promise<void> {
  const state = pluginHelpState(context);
  const scope = state.scope;
  const selectionEpoch = state.selectionEpoch;
  // Capture the rendered selection before an action can outlive its page or Gateway.
  return async (intent) => {
    if (pluginHelpState(context).scope !== scope || state.selectionEpoch !== selectionEpoch) {
      return;
    }
    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
    if (intent && "question" in intent) {
      state.pendingDraft = [state.pendingDraft, intent.question].filter(Boolean).join("\n\n");
    } else if (intent) {
      const setting = intent;
      // Config rendering stays lazy; stale imports cannot attach a question to a
      // replacement Gateway or a newer page selection.
      let formatPluginHelpValue: typeof import("./plugin-help-value.ts").formatPluginHelpValue;
      try {
        ({ formatPluginHelpValue } = await import("./plugin-help-value.ts"));
      } catch {
        if (pluginHelpState(context).scope === scope && state.selectionEpoch === selectionEpoch) {
          showToast({ message: t("custodian.pluginHelpFailed") });
        }
        return;
      }
      if (pluginHelpState(context).scope !== scope || state.selectionEpoch !== selectionEpoch) {
        return;
      }
      const value = formatPluginHelpValue(setting.value, setting.sensitive);
      const question = t("custodian.pluginHelpQuestion", {
        setting: truncateUtf16Safe(setting.label, 96),
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
    notifyPluginHelp(state);
  };
}

export function currentPluginHelpReference(
  context: PluginHelpContext,
): SystemAgentPluginReference | undefined {
  const state = pluginHelpState(context);
  return state.publication?.pathname === pluginHelpPathname(context)
    ? state.publication.reference
    : undefined;
}

export function takePluginHelpDraft(context: PluginHelpContext): string {
  const state = pluginHelpState(context);
  const draft = state.pendingDraft;
  state.pendingDraft = "";
  return draft;
}

export function pluginHelpFocusRequest(context: PluginHelpContext): number {
  return pluginHelpState(context).focusRequest;
}
