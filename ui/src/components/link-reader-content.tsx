import type { JSX } from "@solidjs/web";
import { createSignal, For, onSettled, Repeat, Show } from "solid-js";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { registerLinkReaderEnglish } from "../i18n/locales/en-link-reader.ts";
import { takeGraphemes } from "../lib/graphemes.ts";
import { cancelLayout, scheduleLayout } from "../lib/layout-frame.ts";
import { formatDateTimeMs, formatRelativeTimestamp } from "../lib/reactive/format.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { createIntersectionObserver } from "../lib/reactive/observers.ts";
import { ChecksContent } from "./link-reader-checks.tsx";
import { Diff, FileContent } from "./link-reader-files.tsx";
import {
  LinkReaderMarkdown,
  ReaderLink,
  documentUrl,
  type LoadImage,
} from "./link-reader-markdown.tsx";
import type { ReaderReadyView, ReaderSection } from "./link-reader-panel-view.ts";
import { linkReaderAuthorHref, safePreviewImage } from "./link-reader-response.ts";
import type { LinkReaderTarget } from "./link-reader-target.ts";
import { Icon } from "./solid/icon.tsx";

type ControlUiLinkReaderComment = NonNullable<ControlUiLinkReaderDocument["comments"]>[number];
type SectionKey = "overview" | ReaderSection;
type SectionState = "idle" | "loading" | "error";

registerEnglishCatalog(registerLinkReaderEnglish);

// Recent activity reads as "2h ago"; older dates stay absolute and drop the seconds.
const RELATIVE_DATE_MS = 7 * 24 * 60 * 60 * 1000;
// Document order, which differs from the navigation: checks sit above the description.
const SECTION_ORDER = ["checks", "overview", "files", "discussion"] as const;

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

/** A person: their picture when the source provides one, otherwise their initial. */
function Avatar(props: { name: string; imageUrl?: string }) {
  return (
    <span class="lr-avatar" aria-hidden="true">
      {takeGraphemes(props.name, 1).toUpperCase()}
      <Show when={safePreviewImage(props.imageUrl)}>
        {(source) => (
          <img
            alt=""
            decoding="async"
            crossorigin="anonymous"
            referrerpolicy="no-referrer"
            src={source()}
            onError={(event) => event.currentTarget.remove()}
          />
        )}
      </Show>
    </span>
  );
}

function TruncationNote(props: { truncated: boolean | undefined; label: string }) {
  return (
    <Show when={props.truncated}>
      <p class="lr-note">{t(props.label)}</p>
    </Show>
  );
}

/** One section shell for every load state, so its heading never moves when content arrives. */
function ListSection(props: {
  kind: "files" | "comments";
  /** Loaded rows; undefined until the section arrives. */
  count: number | undefined;
  total?: number;
  truncated?: boolean;
  state?: SectionState;
  children: JSX.Element;
  onLoad: () => void;
  sectionRef: (element: HTMLElement) => void;
}) {
  let element: HTMLElement | undefined;
  const section = () => (props.kind === "files" ? "files" : "discussion");
  const sectionLabel = () => t("linkReader." + section());
  const loaded = () => props.count !== undefined;
  // File diffs are the heaviest section: they load when the reader reaches them.
  createIntersectionObserver(
    () =>
      props.kind === "files" && !loaded() && props.state === "idle" && element ? [element] : [],
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
      aria-label={t(props.kind === "files" ? "linkReader.files" : "linkReader.discussion")}
      class={{ "lr-files": props.kind === "files", "lr-comments": props.kind === "comments" }}
      id={props.kind === "files" ? "files" : undefined}
      data-reader-section={props.kind}
      tabindex={-1}
      aria-busy={!loaded() && props.state === "loading" ? "true" : "false"}
    >
      <h2>
        {t(props.kind === "files" ? "linkReader.files" : "linkReader.discussion")}
        <Show when={props.count ?? props.total}>
          <span class="lr-count">
            {props.count ?? props.total}
            {loaded() && props.total !== undefined && props.total !== props.count
              ? " / " + props.total
              : ""}
          </span>
        </Show>
      </h2>
      <Show
        when={loaded()}
        fallback={
          <Show
            when={props.state !== "error"}
            fallback={
              <p class="lr-section-status">
                <span role="status">
                  {t("linkReader.sectionFailed", { section: sectionLabel() })}
                </span>
                <button class="lr-retry" type="button" onClick={() => props.onLoad()}>
                  {t("linkReader.retry")}
                </button>
              </p>
            }
          >
            {/* One placeholder row per expected row: arrival replaces them in place. */}
            <div
              class={[
                "lr-section-skeleton",
                {
                  "lr-section-skeleton--waiting": props.state === "idle" && props.kind === "files",
                },
              ]}
              role="status"
            >
              {/* Waiting file diffs are not loading yet; only a request in flight is announced. */}
              <Show when={props.state === "loading" || props.kind === "comments"}>
                <span class="sr-only">
                  {t("linkReader.sectionLoading", { section: sectionLabel() })}
                </span>
              </Show>
              <Repeat count={props.kind === "files" ? Math.min(props.total || 3, 30) : 2}>
                {() => <span />}
              </Repeat>
            </div>
          </Show>
        }
      >
        <Show when={props.state}>
          <p class="lr-section-status" role="status">
            {t(
              props.state === "error"
                ? "linkReader.sectionRefreshFailed"
                : "linkReader.sectionRefreshing",
              { section: sectionLabel() },
            )}
            {props.state === "error" && (
              <button type="button" class="lr-retry" onClick={() => props.onLoad()}>
                {t("linkReader.retry")}
              </button>
            )}
          </p>
        </Show>
        {props.children}
        <TruncationNote truncated={props.truncated} label={`linkReader.${props.kind}Truncated`} />
        <Show when={props.count === 0 && !props.truncated}>
          <p class="lr-section-status">
            {t(props.kind === "files" ? "linkReader.noFiles" : "linkReader.noComments")}
          </p>
        </Show>
      </Show>
    </section>
  );
}

/** Checks placeholder with the loaded summary's geometry, so arrival does not move the page. */
function DeferredChecks(props: {
  state: SectionState;
  onLoad: () => void;
  sectionRef: (element: HTMLElement) => void;
}) {
  return (
    <section
      ref={(node) => props.sectionRef(node)}
      class="lr-checks lr-checks--loading"
      data-reader-section="checks"
      tabindex={-1}
      aria-label={t("linkReader.checks")}
      aria-busy={props.state === "loading" ? "true" : "false"}
    >
      <div class="lr-checks-summary">
        <span class="lr-checks-emblem" aria-hidden="true">
          <svg class="lr-checks-meter" viewBox="0 0 32 32">
            <circle class="lr-checks-track" cx="16" cy="16" r="13.5" />
          </svg>
        </span>
        <span class="lr-checks-heading" role="status">
          {props.state === "error"
            ? t("linkReader.sectionFailed", { section: t("linkReader.checks") })
            : t("linkReader.sectionLoading", { section: t("linkReader.checks") })}
        </span>
        {props.state === "error" && (
          <button class="lr-retry" type="button" onClick={() => props.onLoad()}>
            {t("linkReader.retry")}
          </button>
        )}
      </div>
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
  /** The element that scrolls this document; the navigation follows its position. */
  scrollPort?: () => HTMLElement | undefined;
}) {
  const elements: Partial<Record<SectionKey, HTMLElement>> = {};
  let navigation!: HTMLElement;
  // Presentation state: the full check list opens on request, never because a run failed.
  const [checksExpanded, setChecksExpanded] = createSignal(false);
  const [current, setCurrent] = createSignal<SectionKey>("overview");
  onSettled(() => {
    const port = props.scrollPort?.();
    if (!port) {
      return undefined;
    }
    const owner = {};
    const measure = () => {
      const line = navigation.getBoundingClientRect().bottom + 24;
      let next: SectionKey = "overview";
      for (const key of SECTION_ORDER) {
        // A collapsed check summary is part of the overview, not a place of its own.
        if (key === "checks" && !checksExpanded()) {
          continue;
        }
        const element = elements[key];
        if (element?.isConnected && element.getBoundingClientRect().top <= line) {
          next = key;
        }
      }
      // A short last section never reaches the top; the end of the document selects it.
      if (port.scrollTop > 0 && port.scrollTop + port.clientHeight >= port.scrollHeight - 2) {
        next = elements.discussion?.isConnected
          ? "discussion"
          : elements.files?.isConnected
            ? "files"
            : next;
      }
      return () => setCurrent(next);
    };
    const stop = listen(port, "scroll", () => scheduleLayout(owner, measure), { passive: true });
    return () => {
      stop();
      cancelLayout(owner);
    };
  });
  const authorHref = () => linkReaderAuthorHref(props.detail.authorUrl, props.detail.url);
  const coAuthors = () => props.detail.coAuthors ?? [];
  const coAuthorNames = () => {
    const unnamed =
      Math.max(coAuthors().length, props.detail.coAuthorCount ?? 0) - coAuthors().length;
    return (
      coAuthors()
        .map((author) => author.name)
        .join(", ") + (unnamed ? " +" + unnamed : "")
    ).trim();
  };
  // The mark on the Checks tab is named only when it says something: failed, running or passed.
  const checksStatusLabel = () => {
    const state = props.detail.checks?.state;
    return state === "failure"
      ? t("linkReader.checkFailure")
      : state === "pending"
        ? t("linkReader.checkPending")
        : state === "success"
          ? t("linkReader.checkSuccess")
          : undefined;
  };
  // Signed totals such as "+64" sit apart from named facts such as the branch.
  const totals = () => (props.detail.metadata ?? []).filter((item) => item.tone);
  const facts = () => (props.detail.metadata ?? []).filter((item) => !item.tone);
  function SectionLink(link: {
    section: SectionKey;
    label: string;
    count?: number;
    status?: string;
    statusLabel?: string;
    onActivate?: () => void;
  }) {
    return (
      <button
        type="button"
        aria-current={current() === link.section ? "location" : undefined}
        onClick={() => {
          link.onActivate?.();
          const destination = elements[link.section];
          destination?.focus({ preventScroll: true });
          destination?.scrollIntoView({ block: "start" });
        }}
      >
        {link.label}
        <Show when={link.status}>
          {(status) => (
            <span
              class={["lr-nav-status", `lr-nav-status--${status()}`]}
              role={link.statusLabel ? "img" : undefined}
              aria-label={link.statusLabel}
            />
          )}
        </Show>
        <Show when={link.count !== undefined}>
          <span class="lr-count">{link.count}</span>
        </Show>
      </button>
    );
  }
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
        <header>
          <Avatar name={childProps.comment.author} />
          <strong>{childProps.comment.author}</strong>
          <Show when={childProps.comment.label}>
            {(label) => <span class="lr-comment-kind">{label()}</span>}
          </Show>
          <ReaderLink
            class="lr-comment-time"
            href={permalink()}
            title={t("linkReader.commentPermalink")}
          >
            <Show when={childProps.comment.createdAt} fallback={t("linkReader.commentPermalink")}>
              {(value) => <DateLabel value={value()} />}
            </Show>
          </ReaderLink>
        </header>
        <div class="lr-comment-body">
          <Show when={location() || childProps.comment.context?.label || reply()}>
            <p class="lr-review-location">
              <Show when={location()}>
                {(value) => (
                  <ReaderLink class="lr-review-file" href={permalink()}>
                    {value()}
                  </ReaderLink>
                )}
              </Show>
              <Show when={childProps.comment.context?.label}>
                {(label) => <span>{label()}</span>}
              </Show>
              <Show when={reply()}>
                {(url) => (
                  <ReaderLink href={url()}>
                    {childProps.comment.context?.replyLabel ?? t("linkReader.replyContext")}
                  </ReaderLink>
                )}
              </Show>
            </p>
          </Show>
          <Show when={childProps.comment.context?.diff}>
            {(diff) => (
              <details class="lr-review-diff">
                <summary>
                  <span class="lr-file-chevron" aria-hidden="true">
                    <Icon name="chevronRight" />
                  </span>
                  {t("linkReader.reviewContext")}
                </summary>
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
        </div>
      </article>
    );
  }

  return (
    <article class="lr-document">
      <header class="lr-document-header">
        <div class="lr-identity">
          <Show when={props.detail.badge}>
            {(badge) => (
              <span class={["lr-state", `lr-state--${badge().tone}`]}>
                <span class="lr-state-dot" aria-hidden="true" />
                {badge().label}
              </span>
            )}
          </Show>
          <span class="lr-eyebrow">{props.detail.subtitle ?? props.target.reader.label}</span>
          <DateLabel value={props.detail.badge?.timestamp ?? props.detail.createdAt} />
        </div>
        <h1>{props.detail.title}</h1>
        <div class="lr-byline">
          <Show when={props.detail.author}>
            {(author) => {
              const person = () => (
                <>
                  <Avatar name={author()} imageUrl={props.detail.imageUrl} />
                  {author()}
                </>
              );
              return (
                <Show when={authorHref()} fallback={<span class="lr-author">{person()}</span>}>
                  {(href) => (
                    <a
                      class="lr-author"
                      href={href()}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-link-reader-external=""
                    >
                      {person()}
                    </a>
                  )}
                </Show>
              );
            }}
          </Show>
          <Show when={coAuthorNames()}>
            {(names) => (
              <span
                class="lr-coauthors"
                role="img"
                aria-label={t("linkReader.coAuthors", { authors: names() })}
                title={t("linkReader.coAuthors", { authors: names() })}
              >
                <For each={coAuthors().slice(0, 3)}>
                  {(author) => <Avatar name={author.name} imageUrl={author.imageUrl} />}
                </For>
                <Show
                  when={
                    Math.max(coAuthors().length, props.detail.coAuthorCount ?? 0) -
                    Math.min(coAuthors().length, 3)
                  }
                >
                  {(hidden) => <span class="lr-coauthors-more">+{hidden()}</span>}
                </Show>
              </span>
            )}
          </Show>
          <Show when={facts().length}>
            <dl class="lr-facts">
              <For each={facts()}>
                {(item) => (
                  <div class="lr-fact">
                    <dt>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                )}
              </For>
            </dl>
          </Show>
          <Show when={totals().length}>
            <dl class="lr-facts lr-facts--totals">
              <For each={totals()}>
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
                    {/* A signed total such as "+64" reads on sight; its label stays for assistive tech. */}
                    <dt class={{ "sr-only": /^[+−-]\d/.test(item.value) }}>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                )}
              </For>
            </dl>
          </Show>
        </div>
      </header>
      <nav
        ref={(element) => (navigation = element)}
        class="lr-section-nav"
        aria-label={t("linkReader.navigation")}
      >
        <SectionLink section="overview" label={t("linkReader.overview")} />
        <Show when={props.detail.checks || props.sections?.checks}>
          <SectionLink
            section="checks"
            label={t("linkReader.checks")}
            // A state mark, present from the first paint: a late count would move the tabs after it.
            status={props.detail.checks?.state ?? "loading"}
            statusLabel={checksStatusLabel()}
            onActivate={() => {
              props.onLoadSection?.("checks");
              setChecksExpanded(true);
            }}
          />
        </Show>
        <Show when={props.detail.files || props.sections?.files}>
          <SectionLink
            section="files"
            label={t("linkReader.filesShort")}
            count={props.detail.filesTotal ?? props.detail.files?.length}
            onActivate={() => props.onLoadSection?.("files")}
          />
        </Show>
        <Show when={props.detail.comments || props.sections?.discussion}>
          <SectionLink
            section="discussion"
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
          <DeferredChecks
            sectionRef={(element) => (elements.checks = element)}
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
              <p class="lr-section-status">{t("linkReader.noDescription")}</p>
            </div>
          }
        >
          {(body) => (
            <LinkReaderMarkdown body={body()} base={props.detail.url} loadImage={props.loadImage} />
          )}
        </Show>
        <TruncationNote truncated={props.detail.bodyTruncated} label="linkReader.bodyTruncated" />
      </section>
      <Show when={props.detail.files || props.sections?.files}>
        <ListSection
          sectionRef={(element) => (elements.files = element)}
          kind="files"
          count={props.detail.files?.length}
          total={props.detail.filesTotal}
          truncated={props.detail.filesTruncated}
          state={props.sections?.files}
          onLoad={() => props.onLoadSection?.("files")}
        >
          <Show when={props.detail.files?.length}>
            <div class="lr-file-list">
              <For each={props.detail.files} keyed={(file) => file.path}>
                {(file) => (
                  <FileContent
                    file={file()}
                    expanded={props.detail.filesExpanded === true}
                    onScrollPortRef={props.onScrollPortRef}
                  />
                )}
              </For>
            </div>
          </Show>
        </ListSection>
      </Show>
      <Show when={props.detail.comments || props.sections?.discussion}>
        <ListSection
          sectionRef={(element) => (elements.discussion = element)}
          kind="comments"
          count={props.detail.comments?.length}
          total={props.detail.commentsTotal}
          truncated={props.detail.commentsTruncated}
          state={props.sections?.discussion}
          onLoad={() => props.onLoadSection?.("discussion")}
        >
          <For each={props.detail.comments} keyed={(comment) => comment.id}>
            {(comment) => <CommentContent comment={comment()} />}
          </For>
        </ListSection>
      </Show>
    </article>
  );
}
