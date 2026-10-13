import type { ModelCatalogResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import {
  chatModelUnavailableMessage,
  hasChatModelCatalogSelection,
  resolveChatModelOverrideValue,
  resolveChatModelUnavailableReason,
} from "../../lib/chat/model-select-state.ts";
import type { ChatComposerDisabledBanner } from "./components/chat-composer-types.ts";

type ChatModelSetupState = {
  catalog: boolean;
  connected: boolean;
  agentsLoaded: boolean;
  selectedAgentFound: boolean;
  agentModel?: string | null;
  modelSelectionPolicy?: ModelCatalogResult["modelSelectionPolicy"];
  catalogRetired?: boolean;
  catalogInitialized?: boolean;
};

export function resolveChatModelSetup(
  state: ChatModelSetupState &
    Pick<
      Parameters<typeof resolveChatModelOverrideValue>[0],
      "activeSession" | "chatModelCatalog" | "modelOverrides" | "sessionKey" | "sessionsResult"
    > & { catalogError: string | null; onSetup: () => void },
) {
  const policy = state.modelSelectionPolicy;
  const model = policy?.restricted
    ? resolveChatModelOverrideValue(state) || policy.defaultModel
    : state.catalogInitialized === false
      ? undefined
      : (state.activeSession?.model ?? state.agentModel);
  const modelSetupRequired = requiresChatModelSetup(state);
  const provider = policy?.restricted ? undefined : state.activeSession?.modelProvider;
  const catalog = state.chatModelCatalog;
  const onSetup = state.onSetup;
  const retired = state.catalogRetired === true;
  const error = state.catalogError;
  const inference =
    state.activeSession?.placement?.state === "active"
      ? state.activeSession.placement.inference
      : undefined;
  let modelUnavailableBanner: ChatComposerDisabledBanner | undefined;
  if (retired) {
    modelUnavailableBanner = {
      kind: "above-composer",
      text: t(error ? "chat.modelControls.modelsUnavailable" : "chat.modelControls.loadingModels"),
    };
  } else if (
    policy?.restricted &&
    policy.defaultModel === null &&
    !hasChatModelCatalogSelection(model, provider, catalog)
  ) {
    modelUnavailableBanner = {
      kind: "above-composer",
      text: t(
        catalog.some((entry) => entry.manualSelectionAllowed !== false)
          ? "chat.modelControls.selectionRequired"
          : "chat.modelControls.noPermittedModels",
      ),
    };
  } else {
    const message = chatModelUnavailableMessage(
      resolveChatModelUnavailableReason(model, provider, catalog),
      inference,
    );
    modelUnavailableBanner = message ? createChatModelSetupBanner(onSetup, message) : undefined;
  }
  return {
    modelSetupRequired,
    modelUnavailableBanner,
    requiredReason: modelSetupRequired
      ? t("modelSetup.required.body")
      : modelUnavailableBanner?.text,
  };
}

export function requiresChatModelSetup(state: ChatModelSetupState): boolean {
  if (
    state.catalog ||
    state.catalogRetired ||
    state.catalogInitialized === false ||
    state.modelSelectionPolicy?.restricted ||
    !state.connected ||
    !state.agentsLoaded ||
    !state.selectedAgentFound
  ) {
    return false;
  }
  return !state.agentModel?.trim();
}

export function createChatModelSetupBanner(
  onAction: () => void,
  text = t("modelSetup.required.body"),
): ChatComposerDisabledBanner {
  return {
    kind: "above-composer",
    text: `${text} ${t("modelSetup.commandHint")}`,
    actionLabel: t("modelSetup.required.action"),
    onAction,
  };
}
