import { createSignal, Show } from "solid-js";
import { prepareFileReferenceDestination } from "../../../lib/chat/file-reference-destination.ts";
import { focusComposerInput } from "../../../lib/composer-input.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

/** A bound draft can always convert, without enabling or loading dictation. */
export default function ComposerFileReferenceConversion(props: {
  composer: ChatComposerProps;
  state: ChatComposerState;
}) {
  const [failed, setFailed] = createSignal(false);
  const convert = async () => {
    const state = props.state;
    const input = state.composerTextarea;
    if (!input || input.disabled || input.readOnly || state.composerComposing) {
      setFailed(true);
      return;
    }
    const { sessionKey, currentAgentId, gatewayClient } = props.composer;
    const revision = state.editRevision;
    const current = () =>
      input.isConnected &&
      input === state.composerTextarea &&
      revision === state.editRevision &&
      sessionKey === props.composer.sessionKey &&
      currentAgentId === props.composer.currentAgentId &&
      gatewayClient === props.composer.gatewayClient;
    setFailed(false);
    try {
      const destination = await prepareFileReferenceDestination(input);
      if (!current()) {
        return;
      }
      if (input.disabled || input.readOnly || state.composerComposing) {
        setFailed(true);
        return;
      }
      state.fileReferences?.cancel();
      if (destination) {
        destination.clearReferences();
      } else {
        props.composer.onDraftChange(
          props.composer.getDraft?.() ?? props.composer.draft,
          props.composer.getMentions?.() ?? props.composer.mentions,
          [],
        );
      }
      queueMicrotask(() => {
        if (input.isConnected && input === state.composerTextarea) {
          focusComposerInput(input, { preventScroll: true });
        }
      });
    } catch {
      if (current()) {
        const owner = props.state.fileReferences;
        if (owner) {
          owner.cancel("conversion-failed");
        } else {
          setFailed(true);
        }
      }
    }
  };
  return (
    <>
      <button type="button" class="btn btn--small" onClick={() => void convert()}>
        {t("chat.fileReferences.convert")}
      </button>
      <Show when={failed()}>
        <p role="status">{t("chat.fileReferences.conversionFailed")}</p>
      </Show>
    </>
  );
}
