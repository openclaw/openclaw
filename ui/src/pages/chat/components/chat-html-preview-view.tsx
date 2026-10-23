import { lazy } from "solid-js";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatImportBoundary } from "./chat-import-boundary.tsx";
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
  return (
    <ChatImportBoundary
      identity={[props.sourceIdentity, props.content]}
      fallback={() => <HtmlPreviewLoading />}
    >
      <Preview
        desktop={props.desktop ?? false}
        html={props.content}
        sourceIdentity={props.sourceIdentity}
        title={props.title}
        embedSandboxMode={props.embedSandboxMode}
        sessionFileSource={props.sessionFileSource}
      />
    </ChatImportBoundary>
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
