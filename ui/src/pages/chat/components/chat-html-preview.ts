import { createMemo, createSignal } from "solid-js";
import { isStaleChunkImportError } from "../../../app/stale-chunk-reload.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { readFileDraft } from "./chat-file-drafts.ts";
import type {
  SidebarContent,
  AttachmentSidebarRuntime,
  FileSidebarNavigation,
} from "./chat-sidebar-content-types.ts";
export type FileHtmlPreviewControls = NonNullable<
  ReturnType<ReturnType<typeof createFileHtmlPreview>["controls"]>
>;

registerEnglishCatalog(registerFilePreviewEnglish);

export function isHtmlDocument(mimeType: string, filename: string): boolean {
  return (
    mimeType.split(";", 1)[0]?.trim().toLowerCase() === "text/html" || /\.html?$/i.test(filename)
  );
}

/** Owns preview toggles; each selected file/line request restores its initial mode. */
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
  const lineNavigation = createMemo(() => {
    const request = navigation();
    return request?.line != null ? request : null;
  });
  const initialSource = () => {
    const current = file();
    return Boolean(lineNavigation() || current?.line != null);
  };
  const [source, setSource] = createSignal(initialSource);
  const [preview, setPreview] = createSignal(() => {
    const current = file();
    return current && !initialSource()
      ? (readFileDraft(current)?.content ?? current.content)
      : null;
  });

  return {
    get file() {
      return file();
    },
    get showing() {
      return file() !== null && !source();
    },
    showSource: () => setSource(true),
    showPreview() {
      setPreview(text());
      setSource(false);
    },
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
    }) {
      const current = file();
      if (!current) {
        return undefined;
      }
      const previewContent = preview();
      return {
        source: source(),
        onToggle: options.onToggle,
        presentation:
          previewContent === null
            ? null
            : {
                content: previewContent,
                sourceIdentity:
                  current.draftKey ??
                  [
                    options.runtime.sessionKey ?? "",
                    options.runtime.agentId ?? "",
                    current.root ?? "",
                    current.artifactId ?? current.path,
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
