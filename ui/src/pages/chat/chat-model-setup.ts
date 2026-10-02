import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
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
  const modelUnavailableBanner = chatModelUnavailableBanner(
    model,
    policy?.restricted ? undefined : state.activeSession?.modelProvider,
    state.chatModelCatalog,
    state.onSetup,
    {
      retired: state.catalogRetired === true,
      error: state.catalogError,
      modelSelectionPolicy: policy,
    },
  );
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

function chatModelUnavailableBanner(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
  onSetup: () => void,
  catalogState?: {
    retired: boolean;
    error: string | null;
    modelSelectionPolicy?: ModelCatalogResult["modelSelectionPolicy"];
  },
): ChatComposerDisabledBanner | undefined {
  if (catalogState?.retired) {
    return {
      kind: "above-composer",
      text: t(
        catalogState.error
          ? "chat.modelControls.modelsUnavailable"
          : "chat.modelControls.loadingModels",
      ),
    };
  }
  if (
    catalogState?.modelSelectionPolicy?.restricted &&
    catalogState.modelSelectionPolicy.defaultModel === null &&
    !hasChatModelCatalogSelection(model, provider, catalog)
  ) {
    return {
      kind: "above-composer",
      text: t(
        catalog.some((entry) => entry.manualSelectionAllowed !== false)
          ? "chat.modelControls.selectionRequired"
          : "chat.modelControls.noPermittedModels",
      ),
    };
  }
  const message = chatModelUnavailableMessage(
    resolveChatModelUnavailableReason(model, provider, catalog),
  );
  return message ? createChatModelSetupBanner(onSetup, message) : undefined;
}
