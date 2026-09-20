import { parseCanonicalIpAddress } from "@openclaw/net-policy/ip";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing, render, type TemplateResult } from "lit";
import type { ControlUiLinkReaderPreview } from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { takeGraphemes } from "../lib/graphemes.ts";
import {
  linkReaderAuthorHref,
  linkReaderResponseMatchesTarget,
  type LinkReaderTarget,
} from "./link-reader-target.ts";
export type LinkPreview = LinkReaderTarget & ControlUiLinkReaderPreview;

function safePreviewImage(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (/^data:image\/(?:gif|jpeg|png|webp);base64,/u.test(value)) {
    return value;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.+$/u, "");
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.origin !== window.location.origin &&
      host.includes(".") &&
      !/(?:^|\.)(?:localhost|local|internal|localdomain)$/u.test(host) &&
      !parseCanonicalIpAddress(host)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
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
      ? { label: badgeValue.label, tone }
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

function renderAvatar(imageUrl: string | undefined, keepFallback = false) {
  const sourceUrl = safePreviewImage(imageUrl);
  return sourceUrl
    ? html`<img
        class="link-reader-hovercard__image"
        alt=""
        decoding="async"
        crossorigin="anonymous"
        referrerpolicy="no-referrer"
        src=${sourceUrl}
        @error=${(event: Event) => {
          if (event.currentTarget instanceof HTMLImageElement) {
            if (keepFallback) {
              event.currentTarget.hidden = true;
            } else {
              event.currentTarget.remove();
            }
          }
        }}
        @load=${(event: Event) => {
          if (keepFallback && event.currentTarget instanceof HTMLImageElement) {
            event.currentTarget.hidden = false;
          }
        }}
      />`
    : nothing;
}

function renderCoAuthors(preview: ControlUiLinkReaderPreview) {
  const authors = preview.coAuthors ?? [];
  const total = Math.max(authors.length, preview.coAuthorCount ?? 0);
  if (!total) {
    return nothing;
  }
  const faces = authors.filter((author) => safePreviewImage(author.imageUrl)).slice(0, 3);
  const hidden = total - faces.length;
  const unnamed = total - authors.length;
  const names = authors.map((author) => author.name).join(", ") + (unnamed ? " +" + unnamed : "");
  const label = t("linkReader.coAuthors", { authors: names.trim() });
  return html`<span
    class="link-reader-hovercard__coauthors"
    role="img"
    aria-label=${label}
    title=${label}
  >
    ${faces.map(
      (author) => html`<span class="link-reader-hovercard__coauthor" aria-hidden="true">
        ${takeGraphemes(author.name, 1).toUpperCase()}${renderAvatar(author.imageUrl, true)}
      </span>`,
    )}
    ${hidden ? html`<span class="link-reader-hovercard__coauthors-more">+${hidden}</span>` : nothing}
  </span>`;
}

function renderCardLink(
  className: string,
  href: string,
  content: string | TemplateResult,
  external = false,
) {
  return html`<a
    class=${className}
    href=${href}
    target=${EXTERNAL_LINK_TARGET}
    rel=${buildExternalLinkRel()}
    ?data-link-reader-external=${external}
    >${content}</a
  >`;
}

export function renderLoading(card: HTMLDivElement): void {
  card.dataset.loading = "true";
  card.removeAttribute("data-state");
  card.removeAttribute("data-cached");
  card.setAttribute("aria-label", t("linkReader.loadingPreview"));
  const rows = [
    ["header", ["badge", "subtitle", "time"]],
    ["title", ["title"]],
    ["footer", ["author", "metadata"]],
  ] as const;
  render(
    html`<div class="link-reader-hovercard__skeleton" aria-hidden="true">
      ${rows.map(([rowClass, parts]) => html`<div class=${"link-reader-hovercard__" + rowClass}>${parts.map((part) => html`<span class=${"skeleton link-reader-hovercard__placeholder--" + part}></span>`)}</div>`)}
    </div>`,
    card,
  );
}

function renderErrorNotice(message: string) {
  return html`<p class="link-reader-hovercard__error" role="status">${message}</p>`;
}

export function renderPreviewError(
  card: HTMLDivElement,
  target: LinkReaderTarget,
  message: string,
): void {
  card.dataset.loading = "false";
  card.removeAttribute("data-cached");
  card.removeAttribute("data-state");
  card.setAttribute("aria-label", t("linkReader.previewUnavailable"));
  render(
    html`<div class="link-reader-hovercard__title">${t("linkReader.previewUnavailable")}</div>
      ${renderErrorNotice(message)}
      ${renderCardLink("link-reader-hovercard__subtitle", target.href, t("linkReader.openExternal", { provider: target.reader.label }))}`,
    card,
  );
}

export function renderPreview(
  card: HTMLDivElement,
  preview: LinkPreview,
  seeded = false,
  error?: string,
): void {
  card.dataset.loading = "false";
  card.dataset.cached = String(seeded);
  card.dataset.state = preview.badge?.tone ?? "neutral";
  const timestamp = preview.updatedAt ?? preview.createdAt;
  const authorHref = linkReaderAuthorHref(preview.authorUrl, preview.href);
  const author = html`${renderAvatar(preview.imageUrl)}${preview.author ? html`<span class="link-reader-hovercard__author-name">${preview.author}</span>` : nothing}`;
  render(
    html`<div class="link-reader-hovercard__header">
        ${preview.badge ? html`<span class="link-reader-hovercard__state" data-tone=${preview.badge.tone}><span class="link-reader-hovercard__state-dot" aria-hidden="true"></span>${preview.badge.label}</span>` : nothing}
        ${renderCardLink("link-reader-hovercard__subtitle", preview.href, preview.subtitle ?? preview.reader.label)}
        ${seeded ? html`<span class="link-reader-hovercard__time">${t("linkReader.cachedPreview")}</span>` : timestamp ? html`<time class="link-reader-hovercard__time" datetime=${timestamp}>${formatRelativeTimestamp(Date.parse(timestamp))}</time>` : nothing}
      </div>
      ${renderCardLink("link-reader-hovercard__title", preview.href, preview.title)}
      <div class="link-reader-hovercard__footer">
        ${
          preview.author || preview.imageUrl
            ? authorHref
              ? renderCardLink("link-reader-hovercard__author", authorHref, author, true)
              : html`<span class="link-reader-hovercard__author">${author}</span>`
            : nothing
        }
        ${renderCoAuthors(preview)}
        <span class="link-reader-hovercard__metadata"
          >${preview.metadata?.map(({ label, value, tone }) => html`<span class="link-reader-hovercard__metric" data-tone=${tone ?? nothing}>${label ? label + ": " : ""}${value}</span>`)}</span
        >
      </div>
      ${error ? renderErrorNotice(error) : nothing}`,
    card,
  );
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
