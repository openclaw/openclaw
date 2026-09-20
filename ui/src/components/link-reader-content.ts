import { parseCanonicalIpAddress } from "@openclaw/net-policy/ip";
import createDOMPurify from "dompurify";
import { html, nothing } from "lit";
import { guard } from "lit/directives/guard.js";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { i18n, t } from "../i18n/index.ts";
import { registerLinkReaderEnglish } from "../i18n/locales/en-link-reader.ts";
import { linkReaderAuthorHref, type LinkReaderTarget } from "./link-reader-target.ts";
import { createMarkdownParser } from "./markdown-parser.ts";
import { normalizeMarkdownRenderOptions } from "./markdown-render-options.ts";
import { escapeMarkdownHtml } from "./markdown-text.ts";
export { linkReaderContentStyles } from "./link-reader-content.styles.ts";

type ControlUiLinkReaderComment = NonNullable<ControlUiLinkReaderDocument["comments"]>[number];
type ControlUiLinkReaderFile = NonNullable<ControlUiLinkReaderDocument["files"]>[number];

registerLinkReaderEnglish();

const documentOptions = normalizeMarkdownRenderOptions({
  mode: "document",
  codeBlockChrome: "none",
  fileLinks: false,
  interactiveImages: false,
  assistantTranscriptRoleHeaders: false,
});
const markdown = createMarkdownParser();
// Remote attachments commonly use a standalone HTML img. Only that passive
// element is admitted; all other authored HTML keeps the shared parser's rules.
for (const kind of ["html_inline", "html_block"] as const) {
  const original = markdown.renderer.rules[kind]!;
  markdown.renderer.rules[kind] = (tokens, index, options, env, renderer) => {
    const source = tokens[index]?.content ?? "";
    // Reader documents hide comment metadata; code examples never enter these HTML rules.
    if (source.trimStart().startsWith("<!--")) {
      return escapeMarkdownHtml(source.replace(/<!--[\s\S]*?(?:-->|$)/gu, ""));
    }
    return /^<img\s[^<>]*>\s*$/iu.test(source)
      ? source
      : original(tokens, index, options, env, renderer);
  };
}
// A separate instance avoids chat's docs-relative URL hooks. Remote documents
// resolve links against their source, never against the authenticated Gateway.
const purifier = createDOMPurify(window);
const passiveTags = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "details",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

function documentUrl(value: string, base: string): URL | null {
  if (!value.trim()) {
    return null;
  }
  try {
    const url = new URL(value, base);
    return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

function externalAnchor(url: string, label: string): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.textContent = label;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.referrerPolicy = "no-referrer";
  anchor.dataset.linkReaderExternal = "";
  return anchor;
}

type LoadImage = (url: string) => Promise<string>;

function prepareImage(source: HTMLImageElement, base: string, loadImage?: LoadImage): void {
  const url = documentUrl(source.getAttribute("src") ?? "", base);
  const label = source.alt.trim() || t("linkReader.image");
  const wrapper = document.createElement("span");
  wrapper.className = "lr-image";
  const caption = document.createElement("span");
  caption.className = "lr-image-caption";
  const status = document.createElement("span");
  status.textContent = label;
  caption.append(status);
  const linkedImage = source.closest("a");
  // HTTPS + anonymous CORS prevents credentialed cross-origin image loads.
  // Same-origin sources are excluded because anonymous CORS still sends those credentials.
  const hostname = url?.hostname.replace(/\.+$/u, "") ?? "";
  const localHost =
    !hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|localdomain)$/u.test(hostname);
  // Literal addresses stay external; the browser cannot verify a public image host through DNS.
  const supported =
    url?.protocol === "https:" &&
    url.origin !== window.location.origin &&
    !localHost &&
    !parseCanonicalIpAddress(hostname);
  if (url && ["https:", "http:"].includes(url.protocol)) {
    caption.append(" · ", externalAnchor(url.href, t("linkReader.openImage")));
  }
  if (supported && url) {
    const image = document.createElement("img");
    image.alt = label;
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    image.loading = "lazy";
    image.decoding = "async";
    const unavailable = () => {
      image.hidden = true;
      status.textContent = t("linkReader.imageUnavailable", { title: label });
      status.setAttribute("role", "status");
    };
    image.addEventListener("error", unavailable, { once: true });
    if (linkedImage) {
      wrapper.append(image);
    } else {
      const open = externalAnchor(url.href, "");
      open.setAttribute("aria-label", t("linkReader.openImageTitle", { title: label }));
      open.append(image);
      wrapper.append(open);
    }
    if (loadImage) {
      void loadImage(url.href).then((imageUrl) => {
        if (image.isConnected) {
          image.src = imageUrl;
        }
      }, unavailable);
    } else {
      image.src = url.href;
    }
  } else {
    status.textContent = t("linkReader.imageUnavailable", { title: label });
  }
  source.replaceWith(wrapper);
  // Preserve an authored image link without nesting the full-size anchor inside it.
  if (linkedImage) {
    linkedImage.after(caption);
  } else {
    wrapper.append(caption);
  }
}

function renderMarkdown(body: string, base: string, loadImage?: LoadImage) {
  return guard([body, base, loadImage, i18n.getLocale()], () => {
    let rendered: string;
    try {
      rendered = markdown.render(body, documentOptions);
    } catch {
      rendered = "<pre>" + escapeMarkdownHtml(body) + "</pre>";
    }
    const fragment = purifier.sanitize(rendered, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: passiveTags,
      ALLOWED_ATTR: [
        "href",
        "src",
        "alt",
        "title",
        "class",
        "open",
        "start",
        "type",
        "checked",
        "disabled",
      ],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    });
    for (const anchor of fragment.querySelectorAll<HTMLAnchorElement>("a")) {
      const url = documentUrl(anchor.getAttribute("href") ?? "", base);
      if (!url) {
        anchor.removeAttribute("href");
      } else {
        anchor.href = url.href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        anchor.referrerPolicy = "no-referrer";
      }
    }
    for (const input of fragment.querySelectorAll("input")) {
      input.type = "checkbox";
      input.disabled = true;
    }
    for (const image of fragment.querySelectorAll<HTMLImageElement>("img")) {
      prepareImage(image, base, loadImage);
    }
    return fragment;
  });
}

function renderDate(value: string | undefined) {
  if (!value) {
    return nothing;
  }
  const date = new Date(value);
  return html`<time datetime=${value} title=${value}
    >${Number.isNaN(date.getTime()) ? value : date.toLocaleString()}</time
  >`;
}

function renderDiff(patch: string, filename: string) {
  return html`<pre
    class="lr-diff"
    tabindex="0"
    aria-label=${t("linkReader.diffLabel", { filename })}
  ><code>${patch.split("\n").map((line) => {
    const kind = line.startsWith("+")
      ? "add"
      : line.startsWith("-")
        ? "delete"
        : line.startsWith("@@")
          ? "hunk"
          : "context";
    return html`<span class=${"lr-diff-line lr-diff-line--" + kind}>${line}</span>`;
  })}</code></pre>`;
}

function renderFile(file: ControlUiLinkReaderFile, expanded: boolean) {
  return html`<details class="lr-file" ?open=${expanded}>
    <summary>
      <span class="lr-filename">${file.path}</span
      ><span class="lr-stats"
        ><span class="lr-add">+${file.additions}</span>
        <span class="lr-delete">−${file.deletions}</span></span
      >
    </summary>
    ${
      file.previousPath
        ? html`<p class="lr-meta">
            ${t("linkReader.renamedFrom", { filename: file.previousPath })}
          </p>`
        : nothing
    }
    ${
      file.patch
        ? renderDiff(file.patch, file.path)
        : html`<p class="lr-note">${t("linkReader.patchUnavailable")}</p>`
    }
    ${
      file.patchTruncated ? html`<p class="lr-note">${t("linkReader.patchTruncated")}</p>` : nothing
    }
  </details>`;
}

function renderComment(comment: ControlUiLinkReaderComment, base: string, loadImage?: LoadImage) {
  const context = comment.context;
  const location = [context?.path, context?.lineLabel].filter(Boolean).join(":");
  const permalink = documentUrl(comment.url, base)?.href;
  const reply = context?.replyUrl ? documentUrl(context.replyUrl, base)?.href : undefined;
  return html`<article class="lr-comment" id=${comment.id}>
    <header class="lr-meta">
      <strong>${comment.author}</strong>
      <a
        href=${permalink ?? nothing}
        target="_blank"
        rel="noopener noreferrer"
        referrerpolicy="no-referrer"
        title=${t("linkReader.commentPermalink")}
        >${comment.createdAt ? renderDate(comment.createdAt) : t("linkReader.commentPermalink")}</a
      >
      ${comment.label ? html`<span class="lr-comment-kind">${comment.label}</span>` : nothing}
    </header>
    ${
      location || context?.label
        ? html`<p class="lr-review-location">
            <a
              href=${permalink ?? nothing}
              target="_blank"
              rel="noopener noreferrer"
              referrerpolicy="no-referrer"
              >${location}</a
            >
            ${context?.label}
          </p>`
        : nothing
    }
    ${
      reply
        ? html`<a
            class="lr-meta"
            href=${reply}
            target="_blank"
            rel="noopener noreferrer"
            referrerpolicy="no-referrer"
            >${context?.replyLabel ?? t("linkReader.replyContext")}</a
          >`
        : nothing
    }
    ${
      context?.diff
        ? html`<details class="lr-file lr-review-diff">
            <summary>${t("linkReader.reviewContext")}</summary>
            ${renderDiff(context.diff, context.path ?? "")}${
              context.diffTruncated
                ? html`<p class="lr-note">${t("linkReader.patchTruncated")}</p>`
                : nothing
            }
          </details>`
        : nothing
    }
    <div class="lr-markdown">${renderMarkdown(comment.body, base, loadImage)}</div>
    ${
      comment.bodyTruncated
        ? html`<p class="lr-note">${t("linkReader.bodyTruncated")}</p>`
        : nothing
    }
  </article>`;
}

export function renderLinkReaderContent(
  detail: ControlUiLinkReaderDocument,
  target: LinkReaderTarget,
  loadImage?: LoadImage,
) {
  const authorHref = linkReaderAuthorHref(detail.authorUrl, detail.url);
  const coAuthors = detail.coAuthors ?? [];
  const unnamed = Math.max(coAuthors.length, detail.coAuthorCount ?? 0) - coAuthors.length;
  const coAuthorNames =
    coAuthors.map((author) => author.name).join(", ") + (unnamed ? " +" + unnamed : "");
  return html`<div class="lr-meta">${detail.subtitle ?? target.reader.label}</div>
    <h1>${detail.title}</h1>
    <div class="lr-meta lr-item-meta">
      ${
        detail.badge
          ? html`<span class=${"lr-state lr-state--" + detail.badge.tone}
              >${detail.badge.label}</span
            >`
          : nothing
      }
      ${
        detail.author
          ? authorHref
            ? html`<a
                href=${authorHref}
                target="_blank"
                rel="noopener noreferrer"
                data-link-reader-external
                >${t("linkReader.byAuthor", { author: detail.author })}</a
              >`
            : html`<span>${t("linkReader.byAuthor", { author: detail.author })}</span>`
          : nothing
      }
      ${coAuthorNames.trim() ? html`<span class="lr-coauthors">${t("linkReader.coAuthors", { authors: coAuthorNames.trim() })}</span>` : nothing}
      ${renderDate(detail.createdAt)}
      ${detail.metadata?.map(
        ({ label, value, tone }) =>
          html`<span
            >${label ? label + ": " : ""}<span data-tone=${tone ?? nothing}>${value}</span></span
          >`,
      )}
    </div>
    ${
      detail.partial
        ? html`<p class="lr-note" role="status">${t("linkReader.partial")}</p>`
        : nothing
    }
    <section aria-label=${t("linkReader.description")} class="lr-description">
      <div class="lr-markdown">
        ${
          detail.body
            ? renderMarkdown(detail.body, detail.url, loadImage)
            : html`<p class="lr-meta">${t("linkReader.noDescription")}</p>`
        }
      </div>
      ${
        detail.bodyTruncated
          ? html`<p class="lr-note">${t("linkReader.bodyTruncated")}</p>`
          : nothing
      }
    </section>
    ${
      detail.files
        ? html`<section aria-label=${t("linkReader.files")} class="lr-files" id="files">
            <h2>
              ${t("linkReader.files")}
              <span class="lr-meta"
                >${detail.files.length}${
                  detail.filesTotal !== undefined ? " / " + detail.filesTotal : ""
                }</span
              >
            </h2>
            ${detail.files.map((file) => renderFile(file, detail.filesExpanded === true))}
            ${
              detail.filesTruncated
                ? html`<p class="lr-note">${t("linkReader.filesTruncated")}</p>`
                : nothing
            }
            ${
              detail.files.length === 0 && !detail.filesTruncated
                ? html`<p class="lr-meta">${t("linkReader.noFiles")}</p>`
                : nothing
            }
          </section>`
        : nothing
    }
    ${
      detail.comments
        ? html`<section aria-label=${t("linkReader.comments")} class="lr-comments">
            <h2>
              ${t("linkReader.comments")}
              <span class="lr-meta"
                >${detail.comments.length}${
                  detail.commentsTotal !== undefined ? " / " + detail.commentsTotal : ""
                }</span
              >
            </h2>
            ${detail.comments.map((comment) => renderComment(comment, detail.url, loadImage))}
            ${
              detail.commentsTruncated
                ? html`<p class="lr-note">${t("linkReader.commentsTruncated")}</p>`
                : nothing
            }
            ${
              detail.comments.length === 0 && !detail.commentsTruncated
                ? html`<p class="lr-meta">${t("linkReader.noComments")}</p>`
                : nothing
            }
          </section>`
        : nothing
    }`;
}
