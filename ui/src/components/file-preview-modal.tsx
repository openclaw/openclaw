import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, For, Show } from "solid-js";
import { stripFrontmatterBlock } from "../../../packages/markdown-core/src/frontmatter.js";
import { registerFilePreviewEnglish } from "../i18n/locales/en-file-preview.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { type FileKind, fileKindForPath } from "./file-kind.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { CopyButton } from "./solid/copy-button.tsx";
import { Icon, type IconName } from "./solid/icon.tsx";
import { Kbd } from "./solid/kbd.tsx";
import { PanelLoadingSkeleton } from "./solid/panel-loading-skeleton.tsx";
import styles from "./file-preview-modal.styles.css?inline";
import "./modal-dialog.ts";

registerEnglishCatalog(registerFilePreviewEnglish);

export type FilePreviewModalFile = {
  path: string;
  size: string;
  contents: string;
  message?: string;
};
export type FilePreviewModalProps = {
  files: FilePreviewModalFile[];
  activePath: string;
  query: string;
  label: string;
  listLabel: string;
  searchPlaceholder: string;
  contextLabel: string;
  emptyTitle: string;
  emptySubtitle: string;
  copyLabel: string;
  layout: "files" | "document";
  directories: string[];
  loading: boolean;
  fileLoading: boolean;
  error: string;
  notice: string;
};
export type OpenClawFilePreviewModal = SolidBridgeElement<FilePreviewModalProps>;

function MarkdownContent(props: { contents: string; onClick: (event: MouseEvent) => void }) {
  let article!: HTMLElement;
  createEffect(
    () =>
      toSanitizedMarkdownHtml(stripFrontmatterBlock(props.contents), {
        mode: "document",
        remoteImages: false,
        codeBlockChrome: "none",
        fileLinks: false,
      }),
    (html) => {
      // Only the Markdown owner's sanitized output enters this inert template.
      const template = document.createElement("template");
      template.innerHTML = html;
      article.replaceChildren(template.content);
    },
  );
  return (
    <article
      class="markdown"
      ref={(element) => {
        article = element;
      }}
      onClick={(event) => props.onClick(event)}
    />
  );
}

function FilePreviewContent(props: FilePreviewModalProps, host: OpenClawFilePreviewModal) {
  const filteredFiles = createMemo(() => {
    const query = props.layout === "files" ? props.query.trim().toLowerCase() : "";
    return query
      ? props.files.filter((file) => `${file.path}\n${file.contents}`.toLowerCase().includes(query))
      : props.files;
  });
  const activeFile = createMemo(
    () => filteredFiles().find((file) => file.path === props.activePath) ?? filteredFiles()[0],
  );
  const codeSource = createMemo(() => activeFile()?.contents ?? "");
  const codeChunks = createMemo(() => chunkFileContents(codeSource()));
  const listMode = createMemo(() =>
    props.loading && !props.error
      ? "loading"
      : filteredFiles().length === 0
        ? "empty"
        : props.layout,
  );
  const detailMode = createMemo(() =>
    props.error ? "error" : props.loading || props.fileLoading ? "loading" : "file",
  );
  const contentMode = createMemo(() =>
    activeFile()?.message
      ? "message"
      : props.layout === "document" && /\.md$/iu.test(activeFile()?.path ?? "")
        ? "markdown"
        : "code",
  );
  const label = () => props.label || t("filePreview.label");
  const fileCount = () =>
    filteredFiles().length === props.files.length
      ? t("filePreview.fileCount", { count: String(props.files.length) })
      : t("filePreview.filteredFileCount", {
          count: String(filteredFiles().length),
          total: String(props.files.length),
        });
  const emit = (name: string, detail?: string) =>
    host.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  const close = () => emit("file-preview-close");
  const focusModal = () => {
    const target =
      host.querySelector<HTMLElement>(".search") ??
      host.querySelector<HTMLElement>(".item.is-active, .button") ??
      host.querySelector<HTMLElement>(".close-button");
    target?.focus({ preventScroll: true });
  };
  const select = (path: string) => {
    emit("file-preview-select", path);
    if (props.layout === "files") {
      focusModal();
    }
  };
  const preventItemPointerFocus = (event: Event) => {
    if (props.layout === "files") {
      event.preventDefault();
    }
  };
  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const files =
      props.layout === "document"
        ? [...host.querySelectorAll<HTMLButtonElement>(".item")]
            .filter((button) => !button.closest("details:not([open])"))
            .flatMap((button) =>
              filteredFiles().filter((file) => file.path === button.dataset.path),
            )
        : filteredFiles();
    const current = files.findIndex((file) => file.path === props.activePath);
    const next =
      files[
        Math.max(
          0,
          Math.min(files.length - 1, Math.max(0, current) + (event.key === "ArrowDown" ? 1 : -1)),
        )
      ];
    if (next && next.path !== (files[current] ?? files[0])?.path) {
      select(next.path);
    }
  };
  const handleDocumentLink = (event: MouseEvent) => {
    const anchor =
      event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    const href = anchor?.getAttribute("href");
    if (!href || /^[a-z][a-z0-9+.-]*:|^\/\//iu.test(href)) {
      return;
    }
    event.preventDefault();
    const base = new URL(activeFile()?.path ?? "SKILL.md", "https://skill.invalid/");
    const target = new URL(href, base);
    let filePath: string;
    try {
      filePath = decodeURIComponent(target.pathname.slice(1));
    } catch {
      return;
    }
    const file = props.files.find((candidate) => candidate.path === filePath);
    if (file) {
      select(file.path);
    }
  };
  createEffect(
    () =>
      [
        props.layout,
        props.query,
        activeFile()?.path,
        activeFile()?.contents,
        activeFile()?.message,
      ] as const,
    (next, previous) => {
      // A sibling inventory read must not move the document being read.
      if (!previous || next.some((value, index) => value !== previous[index])) {
        const body = host.querySelector<HTMLElement>(".detail-body");
        if (body) {
          body.scrollTop = 0;
          body.scrollLeft = 0;
        }
      }
    },
  );
  createEffect(
    () => [props.activePath, props.query, props.files] as const,
    (next, previous) => {
      host.querySelector<HTMLElement>(".item.is-active")?.scrollIntoView?.({ block: "nearest" });
      if (!previous || (props.layout === "document" && next[0] !== previous[0])) {
        focusModal();
      }
    },
  );
  const item = (file: FilePreviewModalFile) => (
    <button
      class={["item", { "is-active": file.path === activeFile()?.path }]}
      data-path={file.path}
      aria-current={file.path === activeFile()?.path ? "true" : "false"}
      onPointerDown={preventItemPointerFocus}
      onMouseDown={preventItemPointerFocus}
      onClick={() => select(file.path)}
    >
      <span class="item-icon">
        <Icon name={FILE_KIND_ICONS[fileKindForPath(file.path)]} />
      </span>
      <span class="item-name" title={file.path}>
        {props.layout === "document" ? file.path.split("/").pop() : file.path}
      </span>
      <Show when={props.layout === "files"}>
        <span class="item-meta">{file.size}</span>
      </Show>
    </button>
  );
  const folder = (prefix: string): JSX.Element => {
    const files = () => filteredFiles().filter((file) => file.path.startsWith(prefix));
    const direct = () => files().filter((file) => !file.path.slice(prefix.length).includes("/"));
    const folders = () =>
      [
        ...new Set(
          [
            ...files().map((file) => file.path),
            ...props.directories.map((directory) => `${directory}/`),
          ]
            .filter((path) => path.startsWith(prefix) && path.slice(prefix.length).includes("/"))
            .map((path) => path.slice(prefix.length).split("/")[0]!),
        ),
      ].toSorted();
    return (
      <>
        <For each={direct()}>{item}</For>
        <For each={folders()}>
          {(name) => (
            <details class="folder" open>
              <summary>
                <Icon name="folder" />
                <span>{name}</span>
              </summary>
              <div>{folder(`${prefix}${name}/`)}</div>
            </details>
          )}
        </For>
      </>
    );
  };
  return (
    <>
      <style>{styles}</style>
      <openclaw-modal-dialog
        label={label()}
        style={{
          "--openclaw-modal-width": "min(1100px, 92vw)",
          "--openclaw-modal-max-height": "86vh",
        }}
        onModal-cancel={close}
        onKeyDown={handleKeydown}
      >
        <div class="modal">
          <header class="head">
            <Show
              when={props.layout === "document"}
              fallback={
                <>
                  <span class="search-icon">⌕</span>
                  <input
                    class="search"
                    placeholder={props.searchPlaceholder || t("filePreview.searchPlaceholder")}
                    value={props.query}
                    onInput={(event) =>
                      emit("file-preview-query-change", event.currentTarget.value)
                    }
                  />
                  <span class="state">{fileCount()}</span>
                </>
              }
            >
              <h1 class="heading">{label()}</h1>
              <button
                class="close-button"
                type="button"
                aria-label={t("common.close")}
                onClick={close}
              >
                <Icon name="x" />
              </button>
            </Show>
          </header>
          <Show when={props.notice}>
            <p class="notice" role="status">
              {props.notice}
            </p>
          </Show>
          <div
            class={["body", { tree: props.layout === "document" }]}
            aria-busy={props.loading || props.fileLoading ? "true" : "false"}
          >
            <aside class="list">
              <Show when={props.layout === "files"}>
                <div class="list-section">
                  {props.listLabel || t("filePreview.listLabel")} · {filteredFiles().length}
                </div>
              </Show>
              {listMode() === "loading" ? (
                <PanelLoadingSkeleton variant="file-list" label={t("common.loading")} compact />
              ) : listMode() === "empty" ? (
                !props.error && <div class="empty-list">{t("filePreview.noMatches")}</div>
              ) : listMode() === "document" ? (
                folder("")
              ) : (
                <For each={filteredFiles()}>{item}</For>
              )}
            </aside>
            {detailMode() === "error" ? (
              <section class="detail empty">
                <p role="alert">{props.error}</p>
                <button class="button" onClick={() => emit("file-preview-retry")}>
                  {t("common.retry")}
                </button>
              </section>
            ) : detailMode() === "loading" ? (
              <section class="detail">
                <div class="detail-body">
                  <PanelLoadingSkeleton variant="document" label={t("common.loading")} compact />
                </div>
              </section>
            ) : (
              <Show
                when={activeFile()}
                fallback={
                  <section class="detail empty">
                    <p class="empty-title">{props.emptyTitle || t("filePreview.emptyTitle")}</p>
                    <p class="empty-subtitle">
                      {props.emptySubtitle || t("filePreview.emptySubtitle")}
                    </p>
                  </section>
                }
              >
                {(file) => (
                  <section class="detail">
                    <Show when={props.layout === "files"}>
                      <div class="detail-head">
                        <div class="detail-title-row">
                          <h2 class="title">{file().path}</h2>
                          <Show when={file().contents}>
                            <CopyButton
                              text={file().contents}
                              idleLabel={props.copyLabel || t("filePreview.copyFile")}
                              bare
                            />
                          </Show>
                        </div>
                        <div class="chips">
                          <span class="chip accent">{fileKind(file().path)}</span>
                          <span class="chip">{file().size}</span>
                          <span class="chip">{t("filePreview.readOnly")}</span>
                          <Show when={props.contextLabel}>
                            <span class="chip ok">{props.contextLabel}</span>
                          </Show>
                        </div>
                      </div>
                    </Show>
                    <div class="detail-body">
                      {contentMode() === "message" ? (
                        <p role="status">{file().message}</p>
                      ) : contentMode() === "markdown" ? (
                        <MarkdownContent contents={file().contents} onClick={handleDocumentLink} />
                      ) : (
                        <div class="code-content">
                          <For each={codeChunks()}>
                            {(chunk, index) => (
                              <pre class="code-chunk" data-chunk={index()}>
                                {chunk}
                              </pre>
                            )}
                          </For>
                        </div>
                      )}
                    </div>
                  </section>
                )}
              </Show>
            )}
          </div>
          <Show when={props.layout === "files"}>
            <footer class="foot">
              <span class="foot-group">
                <Kbd keys={["↑", "↓"]} class="kbd" /> {t("filePreview.navigate")}
              </span>
              <span class="spacer" />
              <button class="button" onClick={close}>
                {t("common.close")} <Kbd keys="esc" class="kbd" />
              </button>
            </footer>
          </Show>
        </div>
      </openclaw-modal-dialog>
    </>
  );
}

export const FilePreviewModal = defineSolidBridge<FilePreviewModalProps>(
  "openclaw-file-preview-modal",
  FilePreviewContent,
  {
    properties: {
      files: { default: [], attribute: false },
      activePath: { default: "" },
      query: { default: "" },
      label: { default: "" },
      listLabel: { default: "" },
      searchPlaceholder: { default: "" },
      contextLabel: { default: "" },
      emptyTitle: { default: "" },
      emptySubtitle: { default: "" },
      copyLabel: { default: "" },
      layout: { default: "files" },
      directories: { default: [], attribute: false },
      loading: { default: false },
      fileLoading: { default: false },
      error: { default: "" },
      notice: { default: "" },
    },
  },
);

function chunkFileContents(contents: string): string[] {
  const lines = contents.split("\n");
  const chunks: string[] = [];
  for (let index = 0; index < lines.length; index += 64) {
    chunks.push(lines.slice(index, index + 64).join("\n"));
  }
  return chunks;
}
function fileKind(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    md: "Markdown",
    txt: t("filePreview.kind.text"),
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    ts: "TypeScript",
    js: "JavaScript",
    py: "Python",
    sh: t("filePreview.kind.shell"),
  };
  return Object.hasOwn(map, ext) ? map[ext]! : ext ? ext.toUpperCase() : t("filePreview.kind.file");
}
const FILE_KIND_ICONS: Record<FileKind, IconName> = {
  code: "fileCode",
  component: "layoutGrid",
  data: "braces",
  file: "fileText",
  image: "image",
  markdown: "book",
  package: "box",
  shell: "terminal",
  skill: "pencilSparkles",
};
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-file-preview-modal": OpenClawFilePreviewModal;
  }
}
