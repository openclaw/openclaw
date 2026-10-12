import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { registerLinkReaderEnglish } from "../i18n/locales/en-link-reader.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { LinkReaderMarkdown, documentUrl, type LoadImage } from "./link-reader-markdown.tsx";
import { linkReaderAuthorHref } from "./link-reader-response.ts";
import type { LinkReaderTarget } from "./link-reader-target.ts";
import { Icon, type IconName } from "./solid/icon.tsx";

type ControlUiLinkReaderComment = NonNullable<ControlUiLinkReaderDocument["comments"]>[number];
type ControlUiLinkReaderFile = NonNullable<ControlUiLinkReaderDocument["files"]>[number];

registerEnglishCatalog(registerLinkReaderEnglish);

function ReaderLink(props: JSX.IntrinsicElements["a"]) {
  return <a {...props} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" />;
}

function DateLabel(props: { value: string | undefined }) {
  return (
    <Show when={props.value}>
      {(value) => {
        const display = () => {
          const date = new Date(value());
          return Number.isNaN(date.getTime()) ? value() : date.toLocaleString();
        };
        return (
          <time datetime={value()} title={value()}>
            {display()}
          </time>
        );
      }}
    </Show>
  );
}

function Diff(props: { patch: string; filename: string }) {
  return (
    <pre
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
            return <span class={"lr-diff-line lr-diff-line--" + kind}>{line}</span>;
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

function FileContent(props: { file: ControlUiLinkReaderFile; expanded: boolean }) {
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
        {(patch) => <Diff patch={patch()} filename={props.file.path} />}
      </Show>
      <TruncationNote truncated={props.file.patchTruncated} label="linkReader.patchTruncated" />
    </details>
  );
}

function CommentContent(props: {
  comment: ControlUiLinkReaderComment;
  base: string;
  loadImage?: LoadImage;
}) {
  const location = () =>
    [props.comment.context?.path, props.comment.context?.lineLabel].filter(Boolean).join(":");
  const permalink = () => documentUrl(props.comment.url, props.base)?.href;
  const reply = () => {
    const value = props.comment.context?.replyUrl;
    return value ? documentUrl(value, props.base)?.href : undefined;
  };
  return (
    <article class="lr-comment" id={props.comment.id}>
      <header class="lr-meta">
        <strong>{props.comment.author}</strong>{" "}
        <ReaderLink href={permalink()} title={t("linkReader.commentPermalink")}>
          <Show when={props.comment.createdAt} fallback={t("linkReader.commentPermalink")}>
            {(value) => <DateLabel value={value()} />}
          </Show>
        </ReaderLink>{" "}
        <Show when={props.comment.label}>
          {(label) => <span class="lr-comment-kind">{label()}</span>}
        </Show>
      </header>
      <Show when={location() || props.comment.context?.label}>
        <p class="lr-review-location">
          <ReaderLink href={permalink()}>{location()}</ReaderLink> {props.comment.context?.label}
        </p>
      </Show>
      <Show when={reply()}>
        {(url) => (
          <ReaderLink class="lr-meta" href={url()}>
            {props.comment.context?.replyLabel ?? t("linkReader.replyContext")}
          </ReaderLink>
        )}
      </Show>
      <Show when={props.comment.context?.diff}>
        {(diff) => (
          <details class="lr-file lr-review-diff">
            <summary>{t("linkReader.reviewContext")}</summary>
            <Diff patch={diff()} filename={props.comment.context?.path ?? ""} />
            <TruncationNote
              truncated={props.comment.context?.diffTruncated}
              label="linkReader.patchTruncated"
            />
          </details>
        )}
      </Show>
      <LinkReaderMarkdown body={props.comment.body} base={props.base} loadImage={props.loadImage} />
      <TruncationNote truncated={props.comment.bodyTruncated} label="linkReader.bodyTruncated" />
    </article>
  );
}

type ReaderChecks = NonNullable<ControlUiLinkReaderDocument["checks"]>;
const checkIcons: Record<ReaderChecks["state"], IconName> = {
  success: "check",
  failure: "circleX",
  pending: "clock",
  unavailable: "circleQuestionMark",
  neutral: "circle",
};
const checkLabels = {
  success: "linkReader.checkSuccess",
  failure: "linkReader.checkFailure",
  pending: "linkReader.checkPending",
  neutral: "linkReader.checkNeutral",
} as const;
const checksLabels = {
  success: "linkReader.checksSuccess",
  failure: "linkReader.checksFailure",
  pending: "linkReader.checksPending",
  neutral: "linkReader.checksNeutral",
  unavailable: "linkReader.checksUnavailable",
} as const;

function ChecksContent(props: { checks: ReaderChecks; base: string }) {
  const source = () =>
    props.checks.url ? documentUrl(props.checks.url, props.base)?.href : undefined;
  return (
    <details
      class={"lr-checks lr-checks--" + props.checks.state}
      data-reader-section="checks"
      tabindex={-1}
      open={props.checks.state === "failure"}
    >
      <summary>
        <span class="lr-checks-icon" aria-hidden="true">
          <Icon name={checkIcons[props.checks.state]} />
        </span>
        <span class="lr-checks-heading">
          <strong>{t(checksLabels[props.checks.state])}</strong>
          <span class="lr-meta">{props.checks.summary}</span>
        </span>
        <span class="lr-checks-chevron" aria-hidden="true">
          <Icon name="chevronDown" />
        </span>
        <Show
          when={
            !props.checks.truncated &&
            props.checks.state !== "unavailable" &&
            props.checks.items.length === props.checks.total &&
            props.checks.total > 0
          }
        >
          <span class="lr-checks-meter" aria-hidden="true">
            <For each={props.checks.items}>
              {(item) => <span class={"lr-check-segment lr-check-segment--" + item.state} />}
            </For>
          </span>
        </Show>
      </summary>
      <ul class="lr-check-list">
        <For each={props.checks.items}>
          {(item) => {
            const url = () => (item.url ? documentUrl(item.url, props.base)?.href : undefined);
            return (
              <li class={"lr-check lr-check--" + item.state}>
                <span class="lr-check-symbol" role="img" aria-label={t(checkLabels[item.state])}>
                  <Icon name={checkIcons[item.state]} />
                </span>
                <span class="lr-check-copy">
                  <Show when={url()} fallback={<span>{item.name}</span>}>
                    {(href) => (
                      <ReaderLink href={href()} data-link-reader-external="">
                        {item.name}
                        <Icon name="externalLink" />
                      </ReaderLink>
                    )}
                  </Show>
                  <span class="lr-meta">{item.detail ?? t(checkLabels[item.state])}</span>
                </span>
              </li>
            );
          }}
        </For>
      </ul>
      <TruncationNote truncated={props.checks.truncated} label="linkReader.checksTruncated" />
      <footer class="lr-checks-footer">
        <Show when={props.checks.commit}>
          {(commit) => (
            <code title={t("linkReader.checksCommit", { commit: commit() })}>
              {commit().slice(0, 7)}
            </code>
          )}
        </Show>
        <Show when={source()}>
          {(url) => (
            <ReaderLink href={url()} data-link-reader-external="">
              {t("linkReader.checksSource")}
              <Icon name="externalLink" />
            </ReaderLink>
          )}
        </Show>
      </footer>
    </details>
  );
}

function SectionLink(props: { section: string; label: string; count?: number }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        const destination = event.currentTarget
          .closest(".lr-document")
          ?.querySelector<HTMLElement>(`[data-reader-section="${props.section}"]`);
        if (destination instanceof HTMLDetailsElement) {
          destination.open = true;
        }
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
}) {
  return (
    <section
      aria-label={t(`linkReader.${props.kind}`)}
      class={`lr-${props.kind}`}
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

export function LinkReaderContent(props: {
  detail: ControlUiLinkReaderDocument;
  target: LinkReaderTarget;
  loadImage?: LoadImage;
}) {
  const authorHref = () => linkReaderAuthorHref(props.detail.authorUrl, props.detail.url);
  const coAuthorNames = () => {
    const authors = props.detail.coAuthors ?? [];
    const unnamed = Math.max(authors.length, props.detail.coAuthorCount ?? 0) - authors.length;
    return (
      authors.map((author) => author.name).join(", ") + (unnamed ? " +" + unnamed : "")
    ).trim();
  };
  return (
    <article class="lr-document">
      <header class="lr-document-header">
        <div class="lr-eyebrow">{props.detail.subtitle ?? props.target.reader.label}</div>
        <h1>{props.detail.title}</h1>
        <div class="lr-meta lr-item-meta">
          <Show when={props.detail.badge}>
            {(badge) => <span class={"lr-state lr-state--" + badge().tone}>{badge().label}</span>}
          </Show>{" "}
          <Show when={props.detail.author}>
            {(author) => (
              <Show
                when={authorHref()}
                fallback={<span>{t("linkReader.byAuthor", { author: author() })}</span>}
              >
                {(href) => (
                  <a
                    href={href()}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-link-reader-external=""
                  >
                    {t("linkReader.byAuthor", { author: author() })}
                  </a>
                )}
              </Show>
            )}
          </Show>{" "}
          <Show when={coAuthorNames()}>
            {(names) => (
              <span class="lr-coauthors">{t("linkReader.coAuthors", { authors: names() })}</span>
            )}
          </Show>{" "}
          <DateLabel value={props.detail.badge?.timestamp ?? props.detail.createdAt} />
        </div>
        <Show when={props.detail.metadata?.length}>
          <dl class="lr-metadata">
            <For each={props.detail.metadata}>
              {(item) => (
                <div class={["lr-metric", `lr-metric--${item.tone ?? "neutral"}`]}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              )}
            </For>
          </dl>
        </Show>
      </header>
      <nav class="lr-section-nav" aria-label={t("linkReader.navigation")}>
        <SectionLink section="overview" label={t("linkReader.overview")} />
        <Show when={props.detail.checks}>
          {(checks) => (
            <SectionLink section="checks" label={t("linkReader.checks")} count={checks().total} />
          )}
        </Show>
        <Show when={props.detail.files}>
          {(files) => (
            <SectionLink
              section="files"
              label={t("linkReader.filesShort")}
              count={props.detail.filesTotal ?? files().length}
            />
          )}
        </Show>
        <Show when={props.detail.comments}>
          {(comments) => (
            <SectionLink
              section="comments"
              label={t("linkReader.discussion")}
              count={props.detail.commentsTotal ?? comments().length}
            />
          )}
        </Show>
      </nav>
      <Show when={props.detail.checks}>
        {(checks) => <ChecksContent checks={checks()} base={props.detail.url} />}
      </Show>
      <Show when={props.detail.partial}>
        <p class="lr-note" role="status">
          {t("linkReader.partial")}
        </p>
      </Show>
      <section
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
      <Show when={props.detail.files}>
        {(files) => (
          <ListSection
            kind="files"
            count={files().length}
            total={props.detail.filesTotal}
            truncated={props.detail.filesTruncated}
          >
            <For each={files()} keyed={(file) => file.path}>
              {(file) => (
                <FileContent file={file()} expanded={props.detail.filesExpanded === true} />
              )}
            </For>
          </ListSection>
        )}
      </Show>
      <Show when={props.detail.comments}>
        {(comments) => (
          <ListSection
            kind="comments"
            count={comments().length}
            total={props.detail.commentsTotal}
            truncated={props.detail.commentsTruncated}
          >
            <For each={comments()} keyed={(comment) => comment.id}>
              {(comment) => (
                <CommentContent
                  comment={comment()}
                  base={props.detail.url}
                  loadImage={props.loadImage}
                />
              )}
            </For>
          </ListSection>
        )}
      </Show>
    </article>
  );
}
