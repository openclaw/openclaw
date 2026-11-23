import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { registerLinkReaderEnglish } from "../i18n/locales/en-link-reader.ts";
import { elementRef } from "../lib/reactive/element-ref.ts";
import { formatDateTimeMs, formatRelativeTimestamp } from "../lib/reactive/format.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { createIntersectionObserver } from "../lib/reactive/observers.ts";
import { ChecksContent } from "./link-reader-checks.tsx";
import {
  LinkReaderMarkdown,
  ReaderLink,
  documentUrl,
  type LoadImage,
} from "./link-reader-markdown.tsx";
import type { ReaderReadyView, ReaderSection } from "./link-reader-panel-view.ts";
import { linkReaderAuthorHref } from "./link-reader-response.ts";
import type { LinkReaderTarget } from "./link-reader-target.ts";

type ControlUiLinkReaderComment = NonNullable<ControlUiLinkReaderDocument["comments"]>[number];
type ControlUiLinkReaderFile = NonNullable<ControlUiLinkReaderDocument["files"]>[number];

registerEnglishCatalog(registerLinkReaderEnglish);

// Recent activity reads as "2h ago"; older dates stay absolute and drop the seconds.
const RELATIVE_DATE_MS = 7 * 24 * 60 * 60 * 1000;

function DateLabel(props: { value: string | undefined }) {
  return (
    <Show when={props.value}>
      {(value) => {
        const time = () => new Date(value()).getTime();
        return (
          <time
            datetime={value()}
            title={Number.isNaN(time()) ? value() : formatDateTimeMs(time())}
          >
            {Number.isNaN(time())
              ? value()
              : Date.now() - time() < RELATIVE_DATE_MS
                ? formatRelativeTimestamp(time())
                : formatDateTimeMs(time(), { dateStyle: "medium" })}
          </time>
        );
      }}
    </Show>
  );
}

function Diff(props: {
  patch: string;
  filename: string;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
}) {
  return (
    <pre
      ref={[elementRef(props.onScrollPortRef)]}
      class="lr-diff"
      tabindex={0}
      aria-label={t("linkReader.diffLabel", { filename: props.filename })}
    >
      <code>
        <For each={props.patch.split("\n")}>
          {(line) => {
            const kind = line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "delete"
                : line.startsWith("@@")
                  ? "hunk"
                  : "context";
            return <span class={["lr-diff-line", `lr-diff-line--${kind}`]}>{line}</span>;
          }}
        </For>
      </code>
    </pre>
  );
}

function TruncationNote(props: { truncated: boolean | undefined; label: string }) {
  return (
    <Show when={props.truncated}>
      <p class="lr-note">{t(props.label)}</p>
    </Show>
  );
}

function FileContent(props: {
  file: ControlUiLinkReaderFile;
  expanded: boolean;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
}) {
  // Preserve native toggles until the document changes its expansion preference.
  const expanded = createMemo(() => props.expanded);
  return (
    <details class="lr-file" open={expanded()}>
      <summary>
        <span class="lr-filename">{props.file.path}</span>
        <span class="lr-stats">
          <span class="lr-add">+{props.file.additions}</span>{" "}
          <span class="lr-delete">−{props.file.deletions}</span>
        </span>
      </summary>
      <Show when={props.file.previousPath}>
        {(path) => <p class="lr-meta">{t("linkReader.renamedFrom", { filename: path() })}</p>}
      </Show>
      <Show
        when={props.file.patch}
        fallback={<p class="lr-note">{t("linkReader.patchUnavailable")}</p>}
      >
        {(patch) => (
          <Diff
            patch={patch()}
            filename={props.file.path}
            onScrollPortRef={props.onScrollPortRef}
          />
        )}
      </Show>
      <TruncationNote truncated={props.file.patchTruncated} label="linkReader.patchTruncated" />
    </details>
  );
}

function SectionLink(props: {
  destination: () => HTMLElement | undefined;
  label: string;
  count?: number;
  onActivate?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        props.onActivate?.();
        const destination = props.destination();
        destination?.focus({ preventScroll: true });
        destination?.scrollIntoView({ block: "start" });
      }}
    >
      {props.label}
      <Show when={props.count !== undefined}>
        <span class="lr-count">{props.count}</span>
      </Show>
    </button>
  );
}

function ListSection(props: {
  kind: "files" | "comments";
  count: number;
  total?: number;
  truncated?: boolean;
  children: JSX.Element;
  refreshState?: "idle" | "loading" | "error";
  onLoad: () => void;
  sectionRef: (element: HTMLElement) => void;
}) {
  return (
    <section
      ref={(element) => props.sectionRef(element)}
      aria-label={t(`linkReader.${props.kind}`)}
      class={{ "lr-files": props.kind === "files", "lr-comments": props.kind === "comments" }}
      id={props.kind === "files" ? "files" : undefined}
      data-reader-section={props.kind}
      tabindex={-1}
    >
      <h2>
        {t(`linkReader.${props.kind}`)}
        <span class="lr-count">
          {props.count}
          {props.total !== undefined && props.total !== props.count ? " / " + props.total : ""}
        </span>
      </h2>
      <Show when={props.refreshState}>
        <p class="lr-meta" role="status">
          {t(
            props.refreshState === "error"
              ? "linkReader.sectionRefreshFailed"
              : "linkReader.sectionRefreshing",
            {
              section: t(props.kind === "comments" ? "linkReader.discussion" : "linkReader.files"),
            },
          )}
          {props.refreshState === "error" && (
            <button type="button" class="lr-retry" onClick={() => props.onLoad()}>
              {t("linkReader.retry")}
            </button>
          )}
        </p>
      </Show>
      {props.children}
      <TruncationNote truncated={props.truncated} label={`linkReader.${props.kind}Truncated`} />
      <Show when={props.count === 0 && !props.truncated}>
        <p class="lr-meta">
          {t(props.kind === "files" ? "linkReader.noFiles" : "linkReader.noComments")}
        </p>
      </Show>
    </section>
  );
}

function DeferredSection(props: {
  section: ReaderSection;
  state: "idle" | "loading" | "error";
  onLoad: () => void;
  sectionRef: (element: HTMLElement) => void;
}) {
  let element: HTMLElement | undefined;
  const label = () => t("linkReader." + props.section);
  createIntersectionObserver(
    () => (props.section === "files" && props.state === "idle" && element ? [element] : []),
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        props.onLoad();
      }
    },
    { rootMargin: "120px" },
  );
  return (
    <section
      ref={(node) => {
        element = node;
        props.sectionRef(node);
      }}
      class={["lr-section-loading", { "lr-section-loading--checks": props.section === "checks" }]}
      data-reader-section={props.section === "discussion" ? "comments" : props.section}
      tabindex={-1}
      aria-label={label()}
      aria-busy={props.state === "loading" ? "true" : "false"}
    >
      <span
        class={["lr-loading-dot", { "lr-loading-dot--active": props.state === "loading" }]}
        aria-hidden="true"
      />
      <span role="status">
        {props.state === "error"
          ? t("linkReader.sectionFailed", { section: label() })
          : props.section === "files" && props.state === "idle"
            ? t("linkReader.filesOnDemand")
            : t("linkReader.sectionLoading", { section: label() })}
      </span>
      {(props.state === "error" || (props.section === "files" && props.state === "idle")) && (
        <button class="lr-retry" type="button" onClick={() => props.onLoad()}>
          {t(props.state === "error" ? "linkReader.retry" : "linkReader.loadFiles")}
        </button>
      )}
    </section>
  );
}

export function LinkReaderContent(props: {
  detail: ControlUiLinkReaderDocument;
  target: LinkReaderTarget;
  loadImage?: LoadImage;
  sections?: ReaderReadyView["sections"];
  onLoadSection?: (section: ReaderSection) => void;
  onScrollPortRef?: (element: HTMLElement) => void | (() => void);
}) {
  const elements: Partial<Record<"overview" | ReaderSection, HTMLElement>> = {};
  // Presentation state: the full check list opens on request, never because a run failed.
  const [checksExpanded, setChecksExpanded] = createSignal(false);
  const authorHref = () => linkReaderAuthorHref(props.detail.authorUrl, props.detail.url);
  const coAuthorNames = () => {
    const authors = props.detail.coAuthors ?? [];
    const unnamed = Math.max(authors.length, props.detail.coAuthorCount ?? 0) - authors.length;
    return (
      authors.map((author) => author.name).join(", ") + (unnamed ? " +" + unnamed : "")
    ).trim();
  };
  function CommentContent(childProps: { comment: ControlUiLinkReaderComment }) {
    const location = () =>
      [childProps.comment.context?.path, childProps.comment.context?.lineLabel]
        .filter(Boolean)
        .join(":");
    const permalink = () => documentUrl(childProps.comment.url, props.detail.url)?.href;
    const reply = () => {
      const value = childProps.comment.context?.replyUrl;
      return value ? documentUrl(value, props.detail.url)?.href : undefined;
    };
    return (
      <article class="lr-comment" id={childProps.comment.id}>
        <header class="lr-meta">
          <strong>{childProps.comment.author}</strong>{" "}
          <ReaderLink href={permalink()} title={t("linkReader.commentPermalink")}>
            <Show when={childProps.comment.createdAt} fallback={t("linkReader.commentPermalink")}>
              {(value) => <DateLabel value={value()} />}
            </Show>
          </ReaderLink>{" "}
          <Show when={childProps.comment.label}>
            {(label) => <span class="lr-comment-kind">{label()}</span>}
          </Show>
        </header>
        <Show when={location() || childProps.comment.context?.label}>
          <p class="lr-review-location">
            <ReaderLink href={permalink()}>{location()}</ReaderLink>{" "}
            {childProps.comment.context?.label}
          </p>
        </Show>
        <Show when={reply()}>
          {(url) => (
            <ReaderLink class="lr-meta" href={url()}>
              {childProps.comment.context?.replyLabel ?? t("linkReader.replyContext")}
            </ReaderLink>
          )}
        </Show>
        <Show when={childProps.comment.context?.diff}>
          {(diff) => (
            <details class="lr-file lr-review-diff">
              <summary>{t("linkReader.reviewContext")}</summary>
              <Diff
                patch={diff()}
                filename={childProps.comment.context?.path ?? ""}
                onScrollPortRef={props.onScrollPortRef}
              />
              <TruncationNote
                truncated={childProps.comment.context?.diffTruncated}
                label="linkReader.patchTruncated"
              />
            </details>
          )}
        </Show>
        <LinkReaderMarkdown
          body={childProps.comment.body}
          base={props.detail.url}
          loadImage={props.loadImage}
        />
        <TruncationNote
          truncated={childProps.comment.bodyTruncated}
          label="linkReader.bodyTruncated"
        />
      </article>
    );
  }

  return (
    <article class="lr-document">
      <header class="lr-document-header">
        <div class="lr-identity">
          <Show when={props.detail.badge}>
            {(badge) => (
              <span class={["lr-state", `lr-state--${badge().tone}`]}>{badge().label}</span>
            )}
          </Show>
          <span class="lr-eyebrow">{props.detail.subtitle ?? props.target.reader.label}</span>
        </div>
        <h1>{props.detail.title}</h1>
        <div class="lr-meta lr-byline">
          <Show when={props.detail.author}>
            {(author) => (
              <Show when={authorHref()} fallback={<span class="lr-author">{author()}</span>}>
                {(href) => (
                  <a
                    class="lr-author"
                    href={href()}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-link-reader-external=""
                  >
                    {author()}
                  </a>
                )}
              </Show>
            )}
          </Show>
          <Show when={coAuthorNames()}>
            {(names) => (
              <span class="lr-coauthors">{t("linkReader.coAuthors", { authors: names() })}</span>
            )}
          </Show>
          <DateLabel value={props.detail.badge?.timestamp ?? props.detail.createdAt} />
        </div>
        <Show when={props.detail.metadata?.length}>
          <dl class="lr-facts">
            <For each={props.detail.metadata}>
              {(item) => (
                <div
                  class={[
                    "lr-fact",
                    {
                      "lr-fact--positive": item.tone === "positive",
                      "lr-fact--negative": item.tone === "negative",
                    },
                  ]}
                >
                  {/* A toned signed total such as "+64" reads on sight; its label stays for assistive tech. */}
                  <dt class={{ "sr-only": item.tone !== undefined && /^[+−-]\d/.test(item.value) }}>
                    {item.label}
                  </dt>
                  <dd>{item.value}</dd>
                </div>
              )}
            </For>
          </dl>
        </Show>
      </header>
      <nav class="lr-section-nav" aria-label={t("linkReader.navigation")}>
        <SectionLink destination={() => elements.overview} label={t("linkReader.overview")} />
        <Show when={props.detail.checks || props.sections?.checks}>
          <SectionLink
            destination={() => elements.checks}
            label={t("linkReader.checks")}
            count={props.detail.checks?.total}
            onActivate={() => {
              props.onLoadSection?.("checks");
              setChecksExpanded(true);
            }}
          />
        </Show>
        <Show when={props.detail.files || props.sections?.files}>
          <SectionLink
            destination={() => elements.files}
            label={t("linkReader.filesShort")}
            count={props.detail.filesTotal ?? props.detail.files?.length}
            onActivate={() => props.onLoadSection?.("files")}
          />
        </Show>
        <Show when={props.detail.comments || props.sections?.discussion}>
          <SectionLink
            destination={() => elements.discussion}
            label={t("linkReader.discussion")}
            count={props.detail.commentsTotal ?? props.detail.comments?.length}
            onActivate={() => props.onLoadSection?.("discussion")}
          />
        </Show>
      </nav>
      <Show
        when={props.sections?.checks && !props.detail.checks && props.sections.checks}
        fallback={
          <Show when={props.detail.checks}>
            {(checks) => (
              <ChecksContent
                sectionRef={(element) => (elements.checks = element)}
                checks={checks()}
                base={props.detail.url}
                provider={props.target.reader.label}
                expanded={checksExpanded()}
                onExpandedChange={setChecksExpanded}
                refreshState={props.sections?.checks}
              />
            )}
          </Show>
        }
      >
        {(state) => (
          <DeferredSection
            sectionRef={(element) => (elements.checks = element)}
            section="checks"
            state={state()}
            onLoad={() => props.onLoadSection?.("checks")}
          />
        )}
      </Show>
      <Show
        when={
          props.detail.partial &&
          !props.detail.bodyTruncated &&
          !props.detail.filesTruncated &&
          !props.detail.commentsTruncated &&
          !props.detail.checks?.truncated &&
          !props.detail.files?.some((file) => file.patchTruncated) &&
          !props.detail.comments?.some(
            (comment) => comment.bodyTruncated || comment.context?.diffTruncated,
          )
        }
      >
        <p class="lr-note" role="status">
          {t("linkReader.partial")}
        </p>
      </Show>
      <section
        ref={(element) => (elements.overview = element)}
        aria-label={t("linkReader.description")}
        class="lr-description"
        data-reader-section="overview"
        tabindex={-1}
      >
        <Show
          when={props.detail.body}
          fallback={
            <div class="lr-markdown">
              <p class="lr-meta">{t("linkReader.noDescription")}</p>
            </div>
          }
        >
          {(body) => (
            <LinkReaderMarkdown body={body()} base={props.detail.url} loadImage={props.loadImage} />
          )}
        </Show>
        <TruncationNote truncated={props.detail.bodyTruncated} label="linkReader.bodyTruncated" />
      </section>
      <Show when={props.sections?.files && !props.detail.files && props.sections.files}>
        {(state) => (
          <DeferredSection
            sectionRef={(element) => (elements.files = element)}
            section="files"
            state={state()}
            onLoad={() => props.onLoadSection?.("files")}
          />
        )}
      </Show>
      <Show when={props.detail.files}>
        {(files) => (
          <ListSection
            sectionRef={(element) => (elements.files = element)}
            kind="files"
            count={files().length}
            total={props.detail.filesTotal}
            truncated={props.detail.filesTruncated}
            refreshState={props.sections?.files}
            onLoad={() => props.onLoadSection?.("files")}
          >
            <For each={files()} keyed={(file) => file.path}>
              {(file) => (
                <FileContent
                  file={file()}
                  expanded={props.detail.filesExpanded === true}
                  onScrollPortRef={props.onScrollPortRef}
                />
              )}
            </For>
          </ListSection>
        )}
      </Show>
      <Show
        when={props.sections?.discussion && !props.detail.comments && props.sections.discussion}
      >
        {(state) => (
          <DeferredSection
            sectionRef={(element) => (elements.discussion = element)}
            section="discussion"
            state={state()}
            onLoad={() => props.onLoadSection?.("discussion")}
          />
        )}
      </Show>
      <Show when={props.detail.comments}>
        {(comments) => (
          <ListSection
            sectionRef={(element) => (elements.discussion = element)}
            kind="comments"
            count={comments().length}
            total={props.detail.commentsTotal}
            truncated={props.detail.commentsTruncated}
            refreshState={props.sections?.discussion}
            onLoad={() => props.onLoadSection?.("discussion")}
          >
            <For each={comments()} keyed={(comment) => comment.id}>
              {(comment) => <CommentContent comment={comment()} />}
            </For>
          </ListSection>
        )}
      </Show>
    </article>
  );
}
