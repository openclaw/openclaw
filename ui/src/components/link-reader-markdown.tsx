import { parseCanonicalIpAddress } from "@openclaw/net-policy/ip";
import createDOMPurify from "dompurify";
import { full as markdownItEmoji } from "markdown-it-emoji";
import { createEffect, createMemo } from "solid-js";
import { escapeHtml } from "../../../src/shared/html-escape.js";
import { i18n, t as translate } from "../i18n/index.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createMarkdownParser } from "./markdown-parser.ts";
import { normalizeMarkdownRenderOptions } from "./markdown-render-options.ts";

const documentOptions = normalizeMarkdownRenderOptions({
  mode: "document",
  codeBlockChrome: "none",
  fileLinks: false,
  interactiveImages: false,
  assistantTranscriptRoleHeaders: false,
});
const markdown = createMarkdownParser();
// Reader documents support named emoji without changing chat or emoticon text.
markdown.use(markdownItEmoji, { shortcuts: {} });
// Remote attachments commonly use a standalone HTML img. Only that passive
// element is admitted; all other authored HTML keeps the shared parser's rules.
for (const kind of ["html_inline", "html_block"] as const) {
  const original = markdown.renderer.rules[kind]!;
  markdown.renderer.rules[kind] = (tokens, index, options, env, renderer) => {
    const source = tokens[index]?.content ?? "";
    // Reader documents hide comment metadata; code examples never enter these HTML rules.
    if (source.trimStart().startsWith("<!--")) {
      return escapeHtml(source.replace(/<!--[\s\S]*?(?:-->|$)/gu, ""));
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

export function documentUrl(value: string, base: string): URL | null {
  if (!value.trim()) {
    return null;
  }
  const url = URL.parse(value, base);
  return url &&
    ["https:", "http:", "mailto:"].includes(url.protocol) &&
    !url.username &&
    !url.password
    ? url
    : null;
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

export type LoadImage = (url: string) => Promise<string>;

function prepareImage(
  source: HTMLImageElement,
  base: string,
  loadImage: LoadImage | undefined,
  isCurrent: () => boolean,
): void {
  const url = documentUrl(source.getAttribute("src") ?? "", base);
  const label = source.alt.trim() || translate("linkReader.image");
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
    caption.append(" · ", externalAnchor(url.href, translate("linkReader.openImage")));
  }
  if (supported && url) {
    const image = document.createElement("img");
    image.alt = label;
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    image.loading = "lazy";
    image.decoding = "async";
    const unavailable = () => {
      if (!isCurrent()) {
        return;
      }
      image.hidden = true;
      status.textContent = translate("linkReader.imageUnavailable", { title: label });
      status.setAttribute("role", "status");
    };
    image.addEventListener("error", unavailable, { once: true });
    if (linkedImage) {
      wrapper.append(image);
    } else {
      const open = externalAnchor(url.href, "");
      open.setAttribute("aria-label", translate("linkReader.openImageTitle", { title: label }));
      open.append(image);
      wrapper.append(open);
    }
    if (loadImage) {
      void loadImage(url.href).then((imageUrl) => {
        if (isCurrent() && image.isConnected) {
          image.src = imageUrl;
        }
      }, unavailable);
    } else {
      image.src = url.href;
    }
  } else {
    status.textContent = translate("linkReader.imageUnavailable", { title: label });
  }
  source.replaceWith(wrapper);
  // Preserve an authored image link without nesting the full-size anchor inside it.
  if (linkedImage) {
    linkedImage.after(caption);
  } else {
    wrapper.append(caption);
  }
}

export function LinkReaderMarkdown(props: { body: string; base: string; loadImage?: LoadImage }) {
  let element!: HTMLDivElement;
  const source = createMemo(
    () =>
      [props.body, props.base, props.loadImage, i18n.getLocale(), t("linkReader.image")] as const,
    { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
  );
  createEffect(source, ([body, base, loadImage]) => {
    let current = true;
    let rendered: string;
    try {
      rendered = markdown.render(body, documentOptions);
    } catch {
      rendered = "<pre>" + escapeHtml(body) + "</pre>";
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
      prepareImage(image, base, loadImage, () => current);
    }
    element.replaceChildren(fragment);
    return () => {
      current = false;
    };
  });
  return (
    <div
      class="lr-markdown"
      ref={(node) => {
        element = node;
      }}
    />
  );
}
