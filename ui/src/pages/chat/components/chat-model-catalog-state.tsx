import { createMemo, onCleanup, Show } from "solid-js";
import { providerDisplayLabel } from "../../../components/provider-icon.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import type { ChatModelCatalogState as ModelCatalogState } from "../../../lib/model-catalog-store.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { syncChatModelSearch } from "./chat-model-picker-search.ts";
import type { ChatModelCatalogStateProps } from "./chat-model-types.ts";

registerEnglishCatalog(registerModelControlsEnglish);

export function ChatModelCatalogRefresh(props: { state: ModelCatalogState | undefined }) {
  const label = createMemo(() => {
    if (
      !props.state ||
      (props.state.status !== "loading" &&
        !(props.state.status === "ready" && props.state.pendingProviders?.length))
    ) {
      return undefined;
    }
    const providers = props.state.pendingProviders?.map(providerDisplayLabel).join(", ");
    return providers
      ? t("chat.modelControls.refreshingProviderModels", { providers })
      : t("chat.modelControls.refreshingModels");
  });
  return (
    <Show when={label()}>
      {(text) => {
        let indicator: HTMLSpanElement | undefined;
        onCleanup(() => {
          // Capture focus before this disappearing control is removed from the DOM.
          if (indicator?.contains(indicator.ownerDocument.activeElement)) {
            syncChatModelSearch(indicator.closest(".chat-controls__model-picker") ?? undefined);
          }
        });
        return (
          <span
            ref={(element) => {
              indicator = element;
            }}
            class="chat-controls__model-refresh"
            data-chat-model-refresh
            role="status"
          >
            <openclaw-tooltip prop:content={text()} prop:describe={false} open-on-click>
              <button
                class="chat-controls__model-refresh-details"
                type="button"
                aria-label={text()}
              >
                <span class="btn__spinner" aria-hidden="true" />
              </button>
            </openclaw-tooltip>
            <span class="sr-only">{text()}</span>
          </span>
        );
      }}
    </Show>
  );
}

function createCatalogPresentation(props: ChatModelCatalogStateProps) {
  return createMemo(() => {
    const state = props.state;
    if (!state) {
      return undefined;
    }
    const status = state.status;
    const checking = Boolean(state.pendingProviders?.length);
    // A usable catalog refreshes in the search field without moving the model rows.
    if (
      (status === "ready" && props.hasSelectableOptions && !checking) ||
      (props.hasOptions && (status === "loading" || (status === "ready" && checking)))
    ) {
      return undefined;
    }
    const label =
      status === "offline"
        ? t("common.offline")
        : status === "error"
          ? props.hasOptions
            ? t("chat.modelControls.modelsRefreshFailed")
            : (props.errorLabel ?? t("chat.modelControls.modelsUnavailable"))
          : status === "ready" && !checking
            ? (props.emptyLabel ??
              t(
                state.modelSelectionPolicy?.restricted
                  ? "chat.modelControls.noPermittedModels"
                  : "chat.modelControls.noModelsAvailable",
              ))
            : t("chat.modelControls.loadingModels");
    return { status, checking, label };
  });
}

function CatalogAction(props: ChatModelCatalogStateProps & { action: "retry" | "setup" }) {
  return (
    <button
      class="chat-controls__model-catalog-action"
      data-chat-model-target-retry={
        props.action === "retry" ? props.retryTarget?.groupId : undefined
      }
      data-chat-model-setup={props.action === "setup" ? "true" : undefined}
      type="button"
      disabled={props.action === "retry" && props.retryTarget?.disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (props.action === "retry") {
          props.retryTarget?.onRetry(props.retryTarget.groupId);
        } else {
          props.onModelSetup?.();
        }
      }}
    >
      {t(props.action === "retry" ? "common.retry" : "chat.modelControls.emptyModelsAction")}
    </button>
  );
}

export function ChatModelCatalogState(props: ChatModelCatalogStateProps) {
  const presentation = createCatalogPresentation(props);
  return (
    <Show when={presentation()}>
      {(value) => (
        <div
          class={[
            "chat-controls__model-catalog-state",
            {
              "chat-controls__model-catalog-state--empty": !props.hasOptions,
            },
          ]}
          data-chat-model-catalog-state={value().status}
          role="status"
          aria-live="polite"
        >
          <span class="chat-controls__model-catalog-state-label">
            <Show
              when={value().status === "error"}
              fallback={
                <Show
                  when={
                    value().status === "loading" ||
                    value().status === "idle" ||
                    (value().status === "ready" && value().checking)
                  }
                >
                  <span class="btn__spinner" aria-hidden="true" />
                </Show>
              }
            >
              <Icon name="alertTriangle" />
            </Show>
            <span>{value().label}</span>
          </span>
          <Show when={value().status === "error" && props.retryTarget}>
            <CatalogAction {...props} action="retry" />
          </Show>
          <Show
            when={value().status === "ready" && !props.hasSelectableOptions && props.onModelSetup}
          >
            <CatalogAction {...props} action="setup" />
          </Show>
        </div>
      )}
    </Show>
  );
}
