import { createMemo, createSignal, lazy, Show } from "solid-js";
import { registerChatFileReferencesEnglish } from "../../../i18n/locales/en-chat-file-references.ts";
import { prepareFileReferenceDestination } from "../../../lib/chat/file-reference-destination.ts";
import { focusComposerInput } from "../../../lib/composer-input.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import type { ComposerFileReferenceOwner } from "../composer-file-references.ts";
import { readComposerFileReferenceSource } from "./chat-composer-file-reference-options.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

registerEnglishCatalog(registerChatFileReferencesEnglish);

const ComposerFileReferenceReview = lazy(() => import("./chat-composer-file-reference-review.tsx"));

export function ComposerFileReferences(props: {
  composer: ChatComposerProps;
  state: ChatComposerState;
}) {
  const readSource = () => readComposerFileReferenceSource(props.composer, props.state);
  const [loadedOwner, setLoadedOwner] = createSignal<ComposerFileReferenceOwner | null>(null);
  const owner = () => loadedOwner() ?? props.state.fileReferences;
  const [loading, setLoading] = createSignal(false);
  const [failure, setFailure] = createSignal<"unsupported" | "conversionFailed" | null>(null);
  const projection = createMemo(() => {
    const current = owner();
    return current ? projectOwner(current, (value) => value) : null;
  });
  const enable = async (input: HTMLInputElement) => {
    setFailure(null);
    const state = props.state;
    if (state.fileReferences) {
      state.fileReferences.enable(input.checked);
      input.checked = state.fileReferences.enabled;
      return;
    }
    const source = readSource();
    if (!source.connected || !source.eligible || !input.checked) {
      input.checked = false;
      return;
    }
    setLoading(true);
    try {
      const { ComposerFileReferenceOwner } =
        await import("./chat-composer-file-reference-review.tsx");
      const current = readSource();
      if (
        !input.isConnected ||
        source.client !== current.client ||
        source.sessionKey !== current.sessionKey ||
        source.agentId !== current.agentId ||
        !current.connected ||
        !current.eligible
      ) {
        return;
      }
      const loaded = (state.fileReferences ??= new ComposerFileReferenceOwner(readSource));
      loaded.enable(true);
      setLoadedOwner(loaded);
    } catch {
      setFailure("unsupported");
    } finally {
      input.checked = state.fileReferences?.enabled ?? false;
      setLoading(false);
    }
  };
  const convert = async () => {
    const state = props.state;
    const input = state.composerTextarea;
    if (!input) {
      return;
    }
    setFailure(null);
    try {
      const destination = await prepareFileReferenceDestination(input);
      if (input !== props.state.composerTextarea) {
        return;
      }
      props.state.fileReferences?.cancel();
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
      if (input === props.state.composerTextarea) {
        const current = props.state.fileReferences;
        if (current) {
          current.cancel("conversion-failed");
        } else {
          setFailure("conversionFailed");
        }
      }
    }
  };
  return (
    <section class="composer-file-references">
      <label class="composer-file-references__option">
        <input
          type="checkbox"
          checked={projection()?.read().enabled ?? false}
          aria-busy={loading() ? "true" : undefined}
          disabled={loading() || !props.composer.connected || props.composer.canCompose === false}
          onChange={(event) => void enable(event.currentTarget)}
        />
        {t("chat.fileReferences.enable")}
      </label>
      <Show when={(props.composer.getFileReferences?.() ?? props.composer.fileReferences)?.length}>
        <button type="button" class="btn btn--small" onClick={() => void convert()}>
          {t("chat.fileReferences.convert")}
        </button>
      </Show>
      <Show when={failure()}>
        {(key) => <p role="status">{t(`chat.fileReferences.${key()}`)}</p>}
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
