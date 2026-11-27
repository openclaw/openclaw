import { createMemo, createSignal, lazy, Show } from "solid-js";
import { registerChatFileReferencesEnglish } from "../../../i18n/locales/en-chat-file-references.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { isComposerFileReferenceEligible } from "./chat-composer-file-reference-options.ts";
import type { ComposerFileReferenceControlsProps } from "./chat-composer-types.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

registerEnglishCatalog(registerChatFileReferencesEnglish);

const ComposerFileReferenceReview = lazy(() => import("./chat-composer-file-reference-review.tsx"));

const ComposerFileReferenceConversion = lazy(
  () => import("./chat-composer-file-reference-conversion.tsx"),
);

export function ComposerFileReferences(props: ComposerFileReferenceControlsProps) {
  const [owner, setOwner] = props.mountedOwner;
  const canEnable = () =>
    props.composer.connected && isComposerFileReferenceEligible(props.composer);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const projection = createMemo(() => {
    const current = owner();
    return current ? projectOwner(current, (value) => value) : null;
  });
  const enable = async (input: HTMLInputElement) => {
    setFailed(false);
    const state = props.state;
    if (state.fileReferences) {
      state.fileReferences.enable(input.checked);
      input.checked = state.fileReferences.enabled;
      return;
    }
    const requested = input.checked;
    input.checked = false;
    if (!requested || !canEnable()) {
      return;
    }
    const { gatewayClient, sessionKey, currentAgentId } = props.composer;
    setLoading(true);
    try {
      const { activateComposerFileReferences } =
        await import("./chat-composer-file-reference-review.tsx");
      if (input.isConnected) {
        const activated = activateComposerFileReferences(props.composer, state, {
          gatewayClient,
          sessionKey,
          currentAgentId,
        });
        if (activated) {
          setOwner(activated);
          input.checked = activated.enabled;
        }
      }
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section class="composer-file-references" style={{ padding: "6px 12px" }}>
      <label
        class="composer-file-references__option"
        style={{ display: "flex", "align-items": "flex-start", gap: "8px" }}
      >
        <input
          type="checkbox"
          checked={projection()?.read().enabled ?? false}
          aria-busy={loading() ? "true" : undefined}
          disabled={loading() || !canEnable()}
          onChange={(event) => void enable(event.currentTarget)}
        />
        {t("chat.fileReferences.enable")}
      </label>
      <Show when={(props.composer.getFileReferences?.() ?? props.composer.fileReferences)?.length}>
        <ChatLazyBoundary>
          <ComposerFileReferenceConversion composer={props.composer} state={props.state} />
        </ChatLazyBoundary>
      </Show>
      <Show when={failed()}>
        <p role="status">{t("chat.fileReferences.unsupported")}</p>
      </Show>
      <Show when={owner()}>
        {(loaded) => (
          <ChatLazyBoundary>
            <ComposerFileReferenceReview
              owner={loaded()}
              read={() => projection()?.read() ?? loaded()}
              paneId={props.composer.paneId}
              state={props.state}
            />
          </ChatLazyBoundary>
        )}
      </Show>
    </section>
  );
}
