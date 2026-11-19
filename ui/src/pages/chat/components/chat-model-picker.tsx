import {
  createMemo,
  createSignal,
  Errored,
  lazy,
  Loading,
  Show,
  type Element as SolidElement,
} from "solid-js";
import type { ModelAuthStatusResult } from "../../../api/types.ts";
import { hasProviderBrandIcon } from "../../../components/provider-icon-data.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../../components/solid/provider-icon.tsx";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import type { ChatModelCatalogState as ModelCatalogState } from "../../../lib/model-catalog-store.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { ChatContextWindowControlParams } from "./chat-context-window-control.tsx";
import type { ChatModelAccountSection } from "./chat-model-account-control.ts";
import {
  isModelPickerOptionSelected,
  type ChatModelPickerOption as ModelPickerOption,
  type ChatModelPickerTargetGroup,
} from "./chat-model-picker-options.ts";
import {
  ChatModelSearchContext,
  createChatModelSearch,
  handleModelPickerKeydown,
  resetModelSearch,
} from "./chat-model-picker-search.ts";
import { createChatPickerOverlay } from "./chat-picker-overlay.ts";

registerEnglishCatalog(registerModelControlsEnglish);

const ChatModelPickerPanel = lazy(() => import("./chat-model-picker-panel.tsx"), {
  export: "ChatModelPickerPanel",
});

export type ChatModelPickerParams = {
  modelAuthStatusResult?: ModelAuthStatusResult | null;
  authProfileId?: string;
  accountSection?: ChatModelAccountSection;
  contextWindow?: ChatContextWindowControlParams;
  disabled: boolean;
  disabledReason?: string;
  modelCatalogState?: ModelCatalogState;
  /** Lets a lazy route wrap catalog status without adding its read to Chat boot. */
  renderModelCatalogStatus?: (render: () => SolidElement) => SolidElement;
  modelSelectionLocked: boolean;
  selectionScopeDescription?: string;
  modelOptions: ModelPickerOption[];
  open?: boolean;
  targetGroups?: readonly ChatModelPickerTargetGroup[];
  selectedModelValue: string;
  selectedAgentRuntime?: string;
  /** Pin recorded on the session row; only then does an unavailable Default row reset. */
  sessionModelPinned: boolean;
  sessionKey: string;
  triggerModelLabel: string;
  triggerModelValue?: string;
  triggerStatusLabel?: string;
  onModelSetup?: () => void;
  onProviderSettings?: (provider: string) => void;
  onOpen?: () => unknown;
  onOpenChange?: (open: boolean) => void;
  onModelSelect: (
    value: string,
    sessionKey: string,
    agentRuntime?: string | null,
  ) => Promise<unknown>;
  onTargetRetry?: (groupId: string) => unknown;
  onTargetSelect?: (groupId: string, value: string) => unknown;
};

export function ChatModelPicker(params: ChatModelPickerParams) {
  return (
    <Show
      when={Boolean(
        params.modelCatalogState?.status === "ready" &&
        params.modelCatalogState.hasSnapshot &&
        !params.modelCatalogState.pendingProviders?.length &&
        params.modelOptions.length === 0 &&
        // Automatic selection exists even before the first account is configured.
        (!params.accountSection ||
          params.accountSection.viewProps(0).selectionKind === "automatic") &&
        !params.targetGroups?.length &&
        !params.modelSelectionLocked &&
        params.onModelSetup,
      )}
      fallback={<ModelPickerPopover {...params} />}
    >
      <button
        class="chat-controls__inline-select-trigger chat-controls__model-trigger"
        type="button"
        data-chat-model-setup="true"
        disabled={params.disabled}
        aria-description={params.disabledReason}
        onClick={() => params.onModelSetup?.()}
      >
        <span class="chat-controls__inline-select-label">{t("modelSetup.required.action")}</span>
      </button>
    </Show>
  );
}

function ModelPickerPopover(params: ChatModelPickerParams) {
  const search = createChatModelSearch();
  // Retain the panel after first use so expanded model lists survive dismissal.
  const [choicesMounted, mountChoices] = createSignal(false);
  const pickerOverlay = createChatPickerOverlay((target) => {
    search.setOpen(target.open);
    if (target.open) {
      mountChoices(true);
    }
    params.onOpenChange?.(target.open);
    if (!target.open) {
      params.accountSection?.onClose();
      resetModelSearch(target);
      return;
    }
    void params.onOpen?.();
    search.focusOnOpen();
  }, "top");
  const triggerModel = createMemo(() => {
    const triggerModelValue = params.triggerModelValue;
    return triggerModelValue === ""
      ? undefined
      : params.modelOptions.find((option) =>
          isModelPickerOptionSelected(
            option,
            triggerModelValue ?? params.selectedModelValue,
            params.selectedAgentRuntime,
          ),
        );
  });
  const contextWindowBadge = createMemo(() => {
    const contextWindow = params.contextWindow;
    return contextWindow?.selected === contextWindow?.defaultId
      ? undefined
      : contextWindow?.options.find((option) => option.id === contextWindow.selected);
  });
  const triggerLabel = () => params.triggerStatusLabel ?? params.triggerModelLabel;
  const triggerAriaLabel = () => {
    const label = triggerLabel();
    const detail =
      label && triggerModel()?.supportsTools === false
        ? `${label} · ${t("chat.modelControls.chatOnly")}`
        : label;
    return `${t("chat.selectors.model")}${detail ? `: ${detail}` : ""}${params.selectionScopeDescription ? `. ${params.selectionScopeDescription}` : ""}`;
  };
  const showProviderIcon = () => {
    const model = triggerModel();
    return Boolean(
      !params.triggerStatusLabel &&
      model &&
      (model.presentation || hasProviderBrandIcon(model.provider)),
    );
  };
  return (
    <ChatModelSearchContext value={search}>
      <details
        ref={(element) => {
          search.detailsRef(element);
          pickerOverlay.details(element);
        }}
        onClick={pickerOverlay.onClick}
        onToggle={pickerOverlay.onToggle}
        class="chat-controls__inline-select chat-controls__model-picker"
        data-chat-autotype-shortcuts
        prop:open={params.open === true}
        onKeyDown={handleModelPickerKeydown}
      >
        <summary
          ref={[search.summaryRef, pickerOverlay.trigger]}
          class="chat-controls__inline-select-trigger chat-controls__model-trigger"
          data-chat-model-select="true"
          data-chat-model-locked={params.modelSelectionLocked ? "true" : "false"}
          data-chat-select-value={params.selectedModelValue}
          data-chat-model-empty={
            params.modelCatalogState?.hasSnapshot && params.modelOptions.length === 0
              ? "true"
              : "false"
          }
          aria-label={triggerAriaLabel()}
          aria-busy="false"
          aria-disabled={params.disabled ? "true" : "false"}
          aria-description={params.disabledReason}
        >
          <Show when={showProviderIcon()}>
            <ProviderBrandIcon
              provider={triggerModel()!.provider}
              presentation={triggerModel()!.presentation}
              class="chat-controls__trigger-provider-icon"
            />
          </Show>
          <span class="chat-controls__inline-select-label">{triggerLabel()}</span>
          {contextWindowBadge() ? (
            <span
              class="chat-controls__locked-model-badge chat-controls__model-context-badge"
              data-chat-model-context-badge
            >
              {contextWindowBadge()?.label}
            </span>
          ) : undefined}
          <span class="chat-controls__inline-select-chevron" aria-hidden="true">
            <Icon name="chevronUp" />
          </span>
        </summary>
        <div
          ref={pickerOverlay.surface}
          class="oc-overlay chat-picker-overlay"
          data-anchored-overlay
          popover="manual"
        >
          <Show when={choicesMounted()}>
            <Errored
              fallback={(_error, reset) => (
                <div
                  class="chat-controls__model-menu chat-controls__model-catalog-state chat-controls__model-catalog-state--empty"
                  role="alert"
                >
                  {t("chat.modelControls.modelsUnavailable")}
                  <button class="chat-controls__model-catalog-action" type="button" onClick={reset}>
                    {t("common.retry")}
                  </button>
                </div>
              )}
            >
              <Loading>
                <ChatModelPickerPanel params={params} />
              </Loading>
            </Errored>
          </Show>
        </div>
      </details>
    </ChatModelSearchContext>
  );
}
