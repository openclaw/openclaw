import { createMemo, createSignal, Errored, lazy, Loading, onSettled, Show } from "solid-js";
import {
  cancelStaleChunkRecovery,
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "../../../app/stale-chunk-reload.ts";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { SessionFileSource } from "./chat-sidebar-content-types.ts";

export type PreviewProps = {
  desktop?: boolean;
  content: string;
  sourceIdentity: string;
  title: string;
  embedSandboxMode: EmbedSandboxMode;
  sessionFileSource?: SessionFileSource;
};

const Preview = lazy(() => import("./chat-html-preview-element.tsx"), {
  export: "ChatHtmlPreview",
});

export function HtmlPreviewLoading() {
  return <PanelLoadingSkeleton variant="document" label={t("common.loading")} compact />;
}

export function HtmlPreview(props: PreviewProps) {
  const [attempt, setAttempt] = createSignal(0);
  return (
    <Loading on={attempt()} fallback={<HtmlPreviewLoading />}>
      <Errored
        fallback={(error, reset) => {
          // Retire failed-file recovery without remounting an already-rendered preview.
          const source = createMemo(() => [error(), props.sourceIdentity, props.content] as const, {
            equals: (previous, next) => previous.every((value, index) => value === next[index]),
          });
          return (
            <Show when={source()} keyed>
              {([failure]) => {
                const stale = isStaleChunkImportError(failure);
                const [recovery, setRecovery] = createSignal<Promise<boolean>>();
                const recovered = createMemo(() => recovery());
                let active = true;
                let retryButton: HTMLButtonElement | undefined;
                onSettled(() => () => {
                  active = false;
                  if (stale) {
                    cancelStaleChunkRecovery();
                  }
                });
                const retry = () => {
                  if (!active || !retryButton?.isConnected) {
                    return;
                  }
                  if (!stale) {
                    setAttempt((value) => value + 1);
                    reset();
                    return;
                  }
                  const identity = props.sourceIdentity;
                  const content = props.content;
                  const isCurrent = () =>
                    active &&
                    error() === failure &&
                    props.sourceIdentity === identity &&
                    props.content === content;
                  void setRecovery(
                    retryStaleChunkReloadWhenReachable({ canReload: isCurrent }).then(
                      (reloading) => {
                        if (!reloading && isCurrent()) {
                          setAttempt((value) => value + 1);
                          reset();
                        }
                        return reloading;
                      },
                    ),
                  );
                };
                return (
                  <Loading on={recovery()} fallback={<HtmlPreviewLoading />}>
                    {recovered()}
                    <LazyViewError
                      error={error()}
                      stale={stale}
                      onRetry={retry}
                      retryRef={(element) => (retryButton = element)}
                    />
                  </Loading>
                );
              }}
            </Show>
          );
        }}
      >
        <Preview
          desktop={props.desktop ?? false}
          html={props.content}
          sourceIdentity={props.sourceIdentity}
          title={props.title}
          embedSandboxMode={props.embedSandboxMode}
          sessionFileSource={props.sessionFileSource}
        />
      </Errored>
    </Loading>
  );
}

export type SourceFallbackProps = {
  error: Error;
  stale: boolean;
  onRetry: () => void;
  text: string;
};

export function HtmlPreviewSourceFallback(props: SourceFallbackProps) {
  return (
    <>
      <LazyViewError error={props.error} stale={props.stale} onRetry={props.onRetry} />
      <pre class="sidebar-attachment-preview__text">{props.text}</pre>
    </>
  );
}
