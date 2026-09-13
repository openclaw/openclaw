import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";
import { createGatewayQuestionPanelProps } from "./chat-question-card.ts";

export function resolveComposerQuestionPanel(
  props: ChatComposerProps,
  state: ChatComposerState,
  requestUpdate: () => void,
) {
  const gatewayQuestionPrompts =
    props.gatewayQuestionPrompts?.filter(
      (prompt) =>
        props.disabledBanner?.kind !== "composer-replacement" &&
        prompt.status === "pending" &&
        prompt.sessionKey !== undefined &&
        areUiSessionKeysEquivalent(prompt.sessionKey, props.sessionKey),
    ) ?? [];
  let gatewayQuestionIndex = gatewayQuestionPrompts.findIndex(
    (prompt) => prompt.id === state.activeGatewayQuestionId,
  );
  if (gatewayQuestionIndex < 0 && gatewayQuestionPrompts.length > 0) {
    gatewayQuestionIndex = 0;
    state.activeGatewayQuestionId = gatewayQuestionPrompts[0]?.id ?? null;
    state.gatewayQuestionCollapsed = false;
  } else if (gatewayQuestionPrompts.length === 0) {
    state.activeGatewayQuestionId = null;
    state.gatewayQuestionCollapsed = false;
  }
  const gatewayQuestionPrompt = gatewayQuestionPrompts[gatewayQuestionIndex];
  const selectGatewayQuestion = (index: number) => {
    const prompt = gatewayQuestionPrompts[index];
    if (!prompt) {
      return;
    }
    state.activeGatewayQuestionId = prompt.id;
    state.gatewayQuestionCollapsed = false;
    requestUpdate();
  };
  return gatewayQuestionPrompt
    ? createGatewayQuestionPanelProps(gatewayQuestionPrompt, {
        collapsed: state.gatewayQuestionCollapsed,
        onCollapsedChange: (collapsed) => {
          state.gatewayQuestionCollapsed = collapsed;
          state.restoreComposerFocus = collapsed;
          requestUpdate();
        },
        onChange: props.onGatewayQuestionChange,
        onSubmit: props.onGatewayQuestionSubmit
          ? (answers) => props.onGatewayQuestionSubmit?.(gatewayQuestionPrompt.id, answers)
          : undefined,
        onSkip: props.onGatewayQuestionSkip
          ? () => props.onGatewayQuestionSkip?.(gatewayQuestionPrompt.id)
          : undefined,
        requestPosition:
          gatewayQuestionPrompts.length > 1
            ? { current: gatewayQuestionIndex + 1, total: gatewayQuestionPrompts.length }
            : undefined,
        onPreviousRequest: () =>
          selectGatewayQuestion(
            (gatewayQuestionIndex - 1 + gatewayQuestionPrompts.length) %
              gatewayQuestionPrompts.length,
          ),
        onNextRequest: () =>
          selectGatewayQuestion((gatewayQuestionIndex + 1) % gatewayQuestionPrompts.length),
      })
    : null;
}
