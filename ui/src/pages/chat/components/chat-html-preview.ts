import { createSignal, onCleanup } from "solid-js";
import { createLazyCustomElementRequests } from "../../../app/lazy-custom-element.ts";
import { isStaleChunkImportError } from "../../../app/stale-chunk-reload.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { readFileDraft } from "./chat-file-drafts.ts";
import type { PreviewProps, SourceFallbackProps } from "./chat-html-preview-view.tsx";
import type {
  SidebarContent,
  AttachmentSidebarRuntime,
  FileSidebarNavigation,
} from "./chat-sidebar-content-types.ts";
export type FileHtmlPreviewControls = {
  source: boolean;
  presentation: PreviewProps | null;
  sourceFallback?: SourceFallbackProps;
  onToggle: () => void;
};

registerEnglishCatalog(registerFilePreviewEnglish);

export function isHtmlDocument(mimeType: string, filename: string): boolean {
  return (
    mimeType.split(";", 1)[0]?.trim().toLowerCase() === "text/html" || /\.html?$/i.test(filename)
  );
}

export const htmlPreviewElement = {
  tagName: "openclaw-chat-html-preview",
  get label() {
    return t("chat.detailPanel.renderPreview");
  },
  loadModule: () => import("./chat-html-preview-element.tsx"),
};

/** Owns preview toggles; each selected file/navigation restores its initial mode. */
export function createFileHtmlPreview(
  content: () => SidebarContent | null,
  navigation: () => FileSidebarNavigation | null,
  text: () => string,
) {
  const file = () => {
    const current = content();
    return current?.kind === "file" && isHtmlDocument(current.mimeType ?? "", current.name)
      ? current
      : null;
  };
  const initialSource = () => {
    const current = file();
    return Boolean(navigation() || current?.line != null);
  };
  const [source, setSource] = createSignal(initialSource);
  const [preview, setPreview] = createSignal(() => {
    const current = file();
    return current && !initialSource()
      ? (readFileDraft(current)?.content ?? current.content)
      : null;
  });
  const loader = createLazyCustomElementRequests();
  const state = projectOwner(loader, (owner) => owner.visibleState, Object.is);
  onCleanup(() => {
    state.dispose();
    loader.requestWhileActive(htmlPreviewElement, false);
  });

  return {
    get file() {
      return file();
    },
    get showing() {
      return file() !== null && !source();
    },
    showSource: () => setSource(true),
    toggle() {
      if (source()) {
        setPreview(text());
      }
      setSource(!source());
    },
    discard(nextText: string) {
      if (preview() !== null) {
        setPreview(nextText);
      }
    },
    controls(options: {
      error: Error | null;
      onRetry: () => void;
      onToggle: () => void;
      runtime: AttachmentSidebarRuntime;
      mode: EmbedSandboxMode;
    }): FileHtmlPreviewControls | undefined {
      const current = file();
      if (!current) {
        return undefined;
      }
      const previewContent = preview();
      if (previewContent !== null) {
        loader.requestWhileActive(htmlPreviewElement, true);
      }
      return {
        source: source(),
        onToggle: options.onToggle,
        presentation:
          previewContent === null
            ? null
            : {
                state: state.read(),
                onRetry: () => loader.retry(),
                content: previewContent,
                sourceIdentity:
                  current.draftKey ??
                  [
                    options.runtime.sessionKey ?? "",
                    options.runtime.agentId ?? "",
                    current.root ?? "",
                    current.path,
                  ].join(String.fromCharCode(0)),
                title: current.name,
                embedSandboxMode: options.mode,
                sessionFileSource: current.sessionFileSource,
              },
        sourceFallback: options.error
          ? {
              error: options.error,
              stale: isStaleChunkImportError(options.error),
              onRetry: options.onRetry,
              text: text(),
            }
          : undefined,
      };
    },
  };
}
