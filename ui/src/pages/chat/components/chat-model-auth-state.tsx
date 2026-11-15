import { For, Show } from "solid-js";
import { resolveModelRuntimeRoute } from "../../../../../src/shared/model-runtime-route.js";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatModelPickerOption } from "./chat-model-picker-options.ts";

export function modelAuthState(options: ChatModelPickerOption[]) {
  if (
    !options.length ||
    !options.every(
      (option) =>
        option.disabled &&
        (option.unavailableReason === "missing-auth" || option.unavailableReason === "auth-failed"),
    )
  ) {
    return undefined;
  }
  return {
    claude: options.every(
      (option) =>
        resolveModelRuntimeRoute(
          option.provider,
          option.agentRuntimeId ?? option.agentRuntime ?? undefined,
        ) === "claudeCli",
    ),
    failed: options.some((option) => option.unavailableReason === "auth-failed"),
  };
}

export function ChatModelAuthState(props: {
  state: NonNullable<ReturnType<typeof modelAuthState>>;
  onSetup?: () => void;
}) {
  const command = "claude auth login";
  return (
    <div
      class="chat-controls__model-auth-state"
      data-chat-model-auth-state
      data-auth-failed={props.state.failed ? "" : undefined}
      role="status"
    >
      <span>
        {props.state.claude ? (
          <For each={t("chat.modelControls.claudeCliNotReady").split(command)}>
            {(part, index) => (
              <>
                {index() > 0 ? <code>{command}</code> : undefined}
                {part}
              </>
            )}
          </For>
        ) : (
          t(props.state.failed ? "modelSetup.failure.auth" : "modelSetup.candidates.signInNeeded")
        )}
      </span>
      <Show when={props.onSetup}>
        <button
          class="chat-controls__model-catalog-action"
          data-chat-model-setup="true"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            props.onSetup?.();
          }}
        >
          {t(
            props.state.claude
              ? "chat.modelControls.emptyModelsAction"
              : props.state.failed
                ? "connection.browserSignIn.action"
                : "channels.hub.setUp",
          )}
        </button>
      </Show>
    </div>
  );
}
