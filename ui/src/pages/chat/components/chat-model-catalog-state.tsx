import { createMemo, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import type { ChatModelCatalogState as ModelCatalogState } from "../../../lib/model-catalog-store.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerModelControlsEnglish);

type ChatModelCatalogStateProps = {
  state: ModelCatalogState | undefined;
  hasOptions: boolean;
  hasSelectableOptions: boolean;
  onModelSetup?: () => void;
  errorLabel?: string;
  retryTarget?: { disabled: boolean; groupId: string; onRetry: (groupId: string) => unknown };
  emptyLabel?: string;
};

export function isModelCatalogLoading(state: ModelCatalogState | undefined) {
  return Boolean(
    state &&
    (state.status === "idle" ||
      state.status === "loading" ||
      (state.status === "ready" && state.pendingProviders?.length)),
  );
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
  const presentation = createMemo(() => {
    const state = props.state;
    if (!state) {
      return undefined;
    }
    const status = state.status;
    const checking = Boolean(state.pendingProviders?.length);
    if (isModelCatalogLoading(state) || (status === "ready" && props.hasSelectableOptions)) {
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
            : undefined;
    return { status, checking, label };
  });
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
            <Show when={value().status === "error"}>
              <Icon name="alertTriangle" />
            </Show>
            <span>{value().label}</span>
          </span>
          <Show when={value().status === "error" && props.retryTarget}>
            <CatalogAction {...props} action="retry" />
          </Show>
          <Show
            when={
              value().status === "ready" &&
              !value().checking &&
              !props.hasSelectableOptions &&
              props.onModelSetup
            }
          >
            <CatalogAction {...props} action="setup" />
          </Show>
        </div>
      )}
    </Show>
  );
}
