import type { LazyCustomElementRequests } from "../../../app/lazy-custom-element.ts";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { SessionFileSource } from "./chat-sidebar-content-types.ts";

export type PreviewProps = {
  desktop?: boolean;
  state: LazyCustomElementRequests["visibleState"];
  onRetry: () => void;
  content: string;
  sourceIdentity: string;
  title: string;
  embedSandboxMode: EmbedSandboxMode;
  sessionFileSource?: SessionFileSource;
};

export function HtmlPreviewLoading(props: { desktop?: boolean }) {
  return (
    <>
      {props.desktop ? (
        <PanelLoadingSkeleton variant="document" label={t("common.loading")} compact />
      ) : (
        <div role="status">{t("common.loading")}</div>
      )}
    </>
  );
}

export function HtmlPreview(props: PreviewProps) {
  return (
    <>
      {props.state?.status === "error" ? (
        <LazyViewError
          error={props.state.error}
          stale={props.state.stale}
          onRetry={props.onRetry}
        />
      ) : props.state ? (
        <HtmlPreviewLoading desktop={props.desktop} />
      ) : undefined}
      <openclaw-chat-html-preview
        prop:desktop={props.desktop ?? false}
        prop:html={props.content}
        prop:sourceIdentity={props.sourceIdentity}
        prop:title={props.title}
        prop:embedSandboxMode={props.embedSandboxMode}
        prop:sessionFileSource={props.sessionFileSource}
      />
    </>
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
