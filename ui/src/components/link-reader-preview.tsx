import { parseCanonicalIpAddress } from "@openclaw/net-policy/ip";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type { ControlUiLinkReaderPreview } from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { takeGraphemes } from "../lib/graphemes.ts";
import { t } from "../lib/reactive/i18n.ts";
import { parseGitHubLinkTarget } from "./github-link-target.ts";
import { createPreviewRenderer } from "./link-reader-preview-root.ts";
import { linkReaderAuthorHref, linkReaderResponseMatchesTarget } from "./link-reader-response.ts";
import type { LinkReaderTarget } from "./link-reader-target.ts";
import { BrandIcon, Icon } from "./solid/icon.tsx";
export type LinkPreview = LinkReaderTarget & ControlUiLinkReaderPreview;

function safePreviewImage(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (/^data:image\/(?:gif|jpeg|png|webp);base64,/u.test(value)) {
    return value;
  }
  const url = URL.parse(value);
  const host = url?.hostname.replace(/\.+$/u, "") ?? "";
  return url?.protocol === "https:" &&
    !url.username &&
    !url.password &&
    url.origin !== window.location.origin &&
    host.includes(".") &&
    !/(?:^|\.)(?:localhost|local|internal|localdomain)$/u.test(host) &&
    !parseCanonicalIpAddress(host)
    ? url.href
    : undefined;
}

export function parsePreviewResponse(
  target: LinkReaderTarget,
  value: unknown,
): ControlUiLinkReaderPreview {
  const title = isRecord(value) ? readNonBlankString(value.title) : undefined;
  if (
    !isRecord(value) ||
    !title ||
    typeof value.url !== "string" ||
    !linkReaderResponseMatchesTarget(target, value.url)
  ) {
    throw new Error("Invalid link preview response");
  }
  const badgeValue = isRecord(value.badge) ? value.badge : undefined;
  const tone = (["neutral", "positive", "negative", "attention", "accent"] as const).find(
    (item) => item === badgeValue?.tone,
  );
  const badge =
    badgeValue && typeof badgeValue.label === "string" && tone
      ? { label: badgeValue.label, tone, timestamp: readNonBlankString(badgeValue.timestamp) }
      : undefined;
  return {
    url: value.url,
    title,
    subtitle: readNonBlankString(value.subtitle),
    badge,
    author: readNonBlankString(value.author),
    authorUrl: readNonBlankString(value.authorUrl),
    coAuthors: Array.isArray(value.coAuthors)
      ? value.coAuthors.flatMap((author) => {
          const name = isRecord(author) ? readNonBlankString(author.name) : undefined;
          return name && isRecord(author)
            ? [{ name, imageUrl: safePreviewImage(readNonBlankString(author.imageUrl)) }]
            : [];
        })
      : undefined,
    coAuthorCount:
      typeof value.coAuthorCount === "number" &&
      Number.isSafeInteger(value.coAuthorCount) &&
      value.coAuthorCount >= 0
        ? value.coAuthorCount
        : undefined,
    createdAt: readNonBlankString(value.createdAt),
    updatedAt: readNonBlankString(value.updatedAt),
    imageUrl: safePreviewImage(readNonBlankString(value.imageUrl)),
    metadata: Array.isArray(value.metadata)
      ? value.metadata.flatMap((entry) =>
          isRecord(entry) && typeof entry.label === "string" && typeof entry.value === "string"
            ? [
                {
                  label: entry.label,
                  value: entry.value,
                  tone:
                    entry.tone === "positive" || entry.tone === "negative" ? entry.tone : undefined,
                },
              ]
            : [],
        )
      : undefined,
  };
}

function Avatar(props: { imageUrl?: string; keepFallback?: boolean }) {
  return (
    <Show when={safePreviewImage(props.imageUrl)}>
      {(sourceUrl) => (
        <img
          class="link-reader-hovercard__image"
          alt=""
          decoding="async"
          crossorigin="anonymous"
          referrerpolicy="no-referrer"
          src={sourceUrl()}
          onError={(event) => {
            if (props.keepFallback) {
              event.currentTarget.hidden = true;
            } else {
              event.currentTarget.remove();
            }
          }}
          onLoad={(event) => {
            if (props.keepFallback) {
              event.currentTarget.hidden = false;
            }
          }}
        />
      )}
    </Show>
  );
}

function CoAuthors(props: { preview: ControlUiLinkReaderPreview }) {
  const authors = () => props.preview.coAuthors ?? [];
  const total = () => Math.max(authors().length, props.preview.coAuthorCount ?? 0);
  const faces = () =>
    authors()
      .filter((author) => safePreviewImage(author.imageUrl))
      .slice(0, 3);
  const hidden = () => total() - faces().length;
  const label = () => {
    const unnamed = total() - authors().length;
    const names =
      authors()
        .map((author) => author.name)
        .join(", ") + (unnamed ? " +" + unnamed : "");
    return t("linkReader.coAuthors", { authors: names.trim() });
  };
  return (
    <Show when={total()}>
      <span
        class="link-reader-hovercard__coauthors"
        role="img"
        aria-label={label()}
        title={label()}
      >
        <For each={faces()}>
          {(author) => (
            <span class="link-reader-hovercard__coauthor" aria-hidden="true">
              {takeGraphemes(author.name, 1).toUpperCase()}
              <Avatar imageUrl={author.imageUrl} keepFallback />
            </span>
          )}
        </For>
        <Show when={hidden()}>
          <span class="link-reader-hovercard__coauthors-more">+{hidden()}</span>
        </Show>
      </span>
    </Show>
  );
}

function CardLink(props: {
  class: string;
  href: string;
  children: JSX.Element;
  external?: boolean;
}) {
  return (
    <a
      class={props.class}
      href={props.href}
      target={EXTERNAL_LINK_TARGET}
      rel={buildExternalLinkRel()}
      data-link-reader-external={props.external ? "" : undefined}
    >
      {props.children}
    </a>
  );
}

const renderLoadingContent = createPreviewRenderer(() => {
  const rows = [
    ["header", ["badge", "subtitle", "time"]],
    ["title", ["title"]],
    ["footer", ["author", "metadata"]],
  ] as const;
  return (
    <div class="link-reader-hovercard__skeleton" aria-hidden="true">
      <For each={rows}>
        {(row) => (
          <div class={"link-reader-hovercard__" + row[0]}>
            <For each={row[1]}>
              {(part) => <span class={"skeleton link-reader-hovercard__placeholder--" + part} />}
            </For>
          </div>
        )}
      </For>
    </div>
  );
});

export function renderLoading(card: HTMLDivElement, afterCommit: () => void): void {
  card.dataset.loading = "true";
  card.removeAttribute("data-state");
  card.removeAttribute("data-cached");
  card.setAttribute("aria-label", t("linkReader.loadingPreview"));
  renderLoadingContent(card, undefined, afterCommit);
}

function ErrorNotice(props: { message: string }) {
  return (
    <p class="link-reader-hovercard__error" role="status">
      {props.message}
    </p>
  );
}

const renderErrorContent = createPreviewRenderer<{ target: LinkReaderTarget; message: string }>(
  (props) => {
    const target = () => props.value.target;
    const item = () => parseGitHubLinkTarget(target().href);
    const sourceLabel = () => {
      const current = item();
      return current
        ? t(current.kind === "pull" ? "linkReader.previewPullRequest" : "linkReader.previewIssue", {
            number: String(current.number),
          })
        : target().reader.label;
    };
    return (
      <>
        <div class="link-reader-hovercard__error-header">
          <span class="link-reader-hovercard__error-source">
            <Show when={item()}>
              <BrandIcon name="github" />
            </Show>
            <span>{sourceLabel()}</span>
          </span>
          <CardLink class="link-reader-hovercard__error-open" href={target().href}>
            {t("linkReader.openExternal", { provider: target().reader.label })}
            <span aria-hidden="true">
              <Icon name="externalLink" />
            </span>
          </CardLink>
        </div>
        <div class="link-reader-hovercard__error-body">
          <div class="link-reader-hovercard__title">{t("linkReader.previewUnavailable")}</div>
          <ErrorNotice message={props.value.message} />
        </div>
      </>
    );
  },
);

export function renderPreviewError(
  card: HTMLDivElement,
  target: LinkReaderTarget,
  message: string,
  afterCommit: () => void,
): void {
  card.dataset.loading = "false";
  card.removeAttribute("data-cached");
  card.removeAttribute("data-state");
  card.setAttribute("aria-label", t("linkReader.previewUnavailable"));
  renderErrorContent(card, { target, message }, afterCommit);
}

const renderPreviewContent = createPreviewRenderer<{
  preview: LinkPreview;
  seeded: boolean;
  error?: string;
}>((props) => {
  const preview = () => props.value.preview;
  const timestamp = () => preview().updatedAt ?? preview().createdAt;
  const authorHref = () => linkReaderAuthorHref(preview().authorUrl, preview().href);
  const author = () => (
    <>
      <Avatar imageUrl={preview().imageUrl} />
      <Show when={preview().author}>
        <span class="link-reader-hovercard__author-name">{preview().author}</span>
      </Show>
    </>
  );
  return (
    <>
      <div class="link-reader-hovercard__header">
        <Show when={preview().badge}>
          {(badge) => (
            <span class="link-reader-hovercard__state" data-tone={badge().tone}>
              <span class="link-reader-hovercard__state-dot" aria-hidden="true" />
              {badge().label}
            </span>
          )}
        </Show>
        <CardLink class="link-reader-hovercard__subtitle" href={preview().href}>
          {preview().subtitle ?? preview().reader.label}
        </CardLink>
        <Show
          when={props.value.seeded}
          fallback={
            <Show when={timestamp()}>
              {(value) => (
                <time class="link-reader-hovercard__time" datetime={value()}>
                  {formatRelativeTimestamp(Date.parse(value()))}
                </time>
              )}
            </Show>
          }
        >
          <span class="link-reader-hovercard__time">{t("linkReader.cachedPreview")}</span>
        </Show>
      </div>
      <CardLink class="link-reader-hovercard__title" href={preview().href}>
        {preview().title}
      </CardLink>
      <div class="link-reader-hovercard__footer">
        <Show when={preview().author || preview().imageUrl}>
          <Show
            when={authorHref()}
            fallback={<span class="link-reader-hovercard__author">{author()}</span>}
          >
            {(href) => (
              <CardLink class="link-reader-hovercard__author" href={href()} external>
                {author()}
              </CardLink>
            )}
          </Show>
        </Show>
        <CoAuthors preview={preview()} />
        <span class="link-reader-hovercard__metadata">
          <For each={preview().metadata}>
            {(entry) => (
              <span class="link-reader-hovercard__metric" data-tone={entry.tone}>
                {entry.label ? entry.label + ": " : ""}
                {entry.value}
              </span>
            )}
          </For>
        </span>
      </div>
      <Show when={props.value.error}>{(error) => <ErrorNotice message={error()} />}</Show>
    </>
  );
});

export function renderPreview(
  card: HTMLDivElement,
  preview: LinkPreview,
  seeded: boolean,
  error: string | undefined,
  afterCommit: () => void,
): void {
  card.dataset.loading = "false";
  card.dataset.cached = String(seeded);
  card.dataset.state = preview.badge?.tone ?? "neutral";
  renderPreviewContent(card, { preview, seeded, error }, afterCommit);
  card.setAttribute("aria-label", t("linkReader.previewAriaLabel", { title: preview.title }));
}

export type CacheEntry = {
  preview?: ControlUiLinkReaderPreview;
  expiresAt: number;
  promise: Promise<ControlUiLinkReaderPreview>;
  controller: AbortController;
  subscribers: Set<object>;
};

export type PreviewContext = {
  generation: number;
  recoveryScope: string;
  succeeded: boolean;
};

// Page-memory only. Providers share success, never credentials or persisted state.
const previewContexts = new WeakMap<GatewayBrowserClient, Map<string, PreviewContext>>();

export function previewContextFor(
  client: GatewayBrowserClient,
  agentId: string | undefined,
): PreviewContext {
  let contexts = previewContexts.get(client);
  if (!contexts) {
    contexts = new Map();
    previewContexts.set(client, contexts);
  }
  const key = agentId ?? "";
  let context = contexts.get(key);
  if (
    !context ||
    context.generation !== client.connectionGeneration ||
    context.recoveryScope !== client.recoveryScope
  ) {
    context = {
      generation: client.connectionGeneration,
      recoveryScope: client.recoveryScope,
      succeeded: false,
    };
    contexts.set(key, context);
  }
  return context;
}
