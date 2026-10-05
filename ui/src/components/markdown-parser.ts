import MarkdownIt, { type MarkdownIt as MarkdownItParser, type Token } from "markdown-it";
import markdownItCjkFriendly from "markdown-it-cjk-friendly";
import { escapeHtml } from "../../../src/shared/html-escape.js";
import { fileKindForPath, shortestFileLabels } from "./file-kind.ts";
import { isGitHubHost } from "./github-link-eligibility.ts";
import {
  decodeGitHubPathSegment,
  parseGitHubItemPath,
  parseGitHubLinkTarget,
} from "./github-link-target.ts";
import { installAssistantTranscriptRoleMarkdown } from "./markdown-assistant-transcript.ts";
import { markdownCodeBlockCopyText, renderMarkdownCodeBlock } from "./markdown-code-blocks.ts";
import { installMarkdownDetails } from "./markdown-details.ts";
import {
  isHostLocalMarkdownFileHref,
  MARKDOWN_FILE_LINK_SCAN_RE,
  parseMarkdownFileLinkTarget,
  splitMarkdownFileLineSuffix,
} from "./markdown-file-links.ts";
import { installMarkdownGitHubRefs } from "./markdown-github-refs.ts";
import { markdownGitHubHosts } from "./markdown-github-repositories.ts";
import { installMarkdownHumanMentions } from "./markdown-human-mentions.ts";
import { hasMarkdownLinkBoundaries } from "./markdown-link-boundary.ts";
import type { MarkdownRenderEnv } from "./markdown-render-options.ts";
import { installMarkdownSessionLinks } from "./markdown-session-links.ts";
import { installMarkdownTables } from "./markdown-tables.ts";
import { replaceMarkdownTextMatches } from "./markdown-text-replacements.ts";

export const MARKDOWN_GITHUB_PREVIEW_CLASS = "markdown-github-preview";

const DISALLOWED_LINK_SCHEME_RE = /^(?!(?:https?|mailto):)[a-z][a-z0-9+.-]*:/i;
// Raw CJK suffixes delimit autolinks; percent-encoded URL content stays intact.
const CJK_RE = new RegExp(
  "[\\u2E80-\\u2FFF\\u3000-\\u303F\\u3040-\\u309F\\u30A0-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFF01-\\uFF60]",
);

// CSS paints the decorative mark outside the accessibility tree and copied text.
const GITHUB_LINK_CLASS = "markdown-github-link";
// Only generated URL labels may wrap at any character.
const BARE_URL_CLASS = "markdown-bare-url";
// Code-span URLs use the same generated labels as autolinks.
const CODE_SPAN_LINK_MARKUP = "code-span-url";
const CODE_SPAN_URL_BREAK_RE = /[\s\p{Cc}]/u;

// Core rules classify file links before the code_inline renderer consumes them.
type MarkdownFileLinkMeta = {
  path: string;
  line: number | null;
  // Full original reference, set only when the visible label was shortened.
  title: string | null;
};

// Label shortening needs every file target before applying any label.
type MarkdownFileLinkDecoration = {
  path: string;
  reference: string;
  applyLabel: (label: string) => void;
};

const PROGRESS_HTML_RE = /^(?:<progress(?:\s[^<>]*)?>\s*(?:<\/progress>)?|<\/progress>)$/iu;

function renderRawMarkdownHtml(
  tokens: readonly Token[],
  index: number,
  progressBars: boolean,
  block: boolean,
): string {
  const token = tokens[index];
  if (!token) {
    return "";
  }
  const content = token.content;
  if (progressBars) {
    return PROGRESS_HTML_RE.test(content.trim()) ? content : "";
  }
  if (/^<br\s*\/?>$/iu.test(content.trim())) {
    return block ? "<br>\n" : "<br>";
  }
  return escapeHtml(content) + (block ? "\n" : "");
}

/** Authored labels differ from labels that merely repeat the reference. */
function linkLabelText(children: readonly Token[], openIndex: number): string {
  let label = "";
  for (let cursor = openIndex + 1; cursor < children.length; cursor++) {
    const token = children[cursor];
    if (!token || token.type === "link_close") {
      break;
    }
    if (token.type === "text" || token.type === "code_inline") {
      label += token.content;
    }
  }
  return label.trim();
}

function parseWebLinkHref(href: string): URL | null {
  // Docs-relative rewriting runs later in markdown.ts.
  const url = URL.parse(href);
  return url?.protocol === "https:" || url?.protocol === "http:" ? url : null;
}

function formatGitHubLinkLabel(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 2) {
    return segments.map((segment) => decodeGitHubPathSegment(segment) ?? segment).join("/");
  }
  if ((segments[2] === "blob" || segments[2] === "tree") && segments.length > 4) {
    const basename = decodeGitHubPathSegment(segments.at(-1) ?? "");
    if (basename) {
      // Tree URLs can contain slash-separated refs, not just folder paths.
      // Show the omission rather than presenting the suffix as a folder name.
      return segments[2] === "tree"
        ? `${segments
            .slice(0, 2)
            .map((segment) => decodeGitHubPathSegment(segment) ?? segment)
            .join("/")}/…/${basename}`
        : basename;
    }
  }
  const path = segments.map((segment) => decodeGitHubPathSegment(segment) ?? segment);
  return [url.host, ...path].join("/");
}

export function createMarkdownParser(): MarkdownItParser {
  const markdownParser = new MarkdownIt({
    html: true, // Enable HTML recognition so html_block/html_inline overrides can escape it
    breaks: true,
    linkify: true,
  });
  markdownParser.use(markdownItCjkFriendly);
  const defaultCodeInlineRenderer = markdownParser.renderer.rules.code_inline!;

  markdownParser.enable("strikethrough");
  installAssistantTranscriptRoleMarkdown(markdownParser);
  installMarkdownDetails(markdownParser);
  installMarkdownTables(markdownParser);

  // Bare filenames such as README.md are not web destinations.
  markdownParser.linkify.set({ fuzzyLink: false });

  // Keep GFM's www. autolinks without fuzzy filename detection.
  markdownParser.linkify.add("www", {
    validate(text, pos) {
      const tail = text.slice(pos);
      // Preserve the previous autolink grammar, including its CJK boundary.
      const match = tail.match(
        /^\.(?:[a-zA-Z0-9-]+\.?)+[^\s<\u2E80-\u2FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF60]*/,
      );
      if (!match) {
        return 0;
      }
      let length = match[0].length;

      // Strip trailing close chars only when unbalanced (more closes than opens).
      // For self-matching pairs like "", open === close (strip if odd count).
      const balancePairs: Record<string, string> = {
        ")": "(",
        "]": "[",
        "}": "{",
        '"': '"',
        "'": "'",
      };

      // Pre-count delimiters to avoid quadratic suffix scans.
      const balance: Record<string, number> = {};
      for (const [close, open] of Object.entries(balancePairs)) {
        balance[close] = 0;
        for (let index = 0; index < length; index++) {
          const character = tail.charAt(index);
          if (open === close) {
            if (character === open) {
              balance[close] = balance[close] === 0 ? 1 : 0;
            }
          } else if (character === open) {
            balance[close] = (balance[close] ?? 0) + 1;
          } else if (character === close) {
            balance[close] = (balance[close] ?? 0) - 1;
          }
        }
      }

      while (length > 0) {
        const character = tail.charAt(length - 1);
        if (/[?!.,:*_~]/.test(character)) {
          length--;
          continue;
        }
        // GFM entity reference rule: strip trailing &entity; sequences.
        if (character === ";") {
          let index = length - 2;
          while (index >= 0 && /[a-zA-Z0-9]/.test(tail.charAt(index))) {
            index--;
          }
          // index < length - 2 ensures at least one alphanumeric between & and ;
          if (index >= 0 && tail.charAt(index) === "&" && index < length - 2) {
            length = index;
            continue;
          }
          break;
        }
        const open = balancePairs[character];
        if (open !== undefined) {
          if (open === character) {
            if ((balance[character] ?? 0) !== 0) {
              balance[character] = 0;
              length--;
              continue;
            }
          } else if ((balance[character] ?? 0) < 0) {
            balance[character] = (balance[character] ?? 0) + 1;
            length--;
            continue;
          }
        }
        break;
      }
      return length;
    },
    normalize(match) {
      match.url = "http://" + match.url;
    },
  });

  // Keep label tokens for invalid destinations; the rule below removes only the
  // link wrapper so rejected Markdown stays readable without a false affordance.
  markdownParser.validateLink = () => true;

  markdownParser.core.ruler.after("linkify", "disallowed-link-schemes", (state) => {
    for (const blockToken of state.tokens) {
      const children = blockToken.children;
      if (blockToken.type !== "inline" || !children) {
        continue;
      }
      let hideClose = false;
      for (const token of children) {
        if (
          token.type === "link_open" &&
          DISALLOWED_LINK_SCHEME_RE.test(String(token.attrGet("href") ?? ""))
        ) {
          token.hidden = true;
          hideClose = true;
        } else if (token.type === "link_close" && hideClose) {
          token.hidden = true;
          hideClose = false;
        }
      }
    }
  });

  // Linkify can swallow adjacent CJK prose; return only its suffix to plain text.
  markdownParser.core.ruler.after("linkify", "linkify-cjk-trim", (state) => {
    for (const blockToken of state.tokens) {
      if (blockToken.type !== "inline" || !blockToken.children) {
        continue;
      }
      const children = blockToken.children;
      for (let index = children.length - 1; index >= 0; index--) {
        const token = children[index];
        if (!token || token.type !== "link_open") {
          continue;
        }
        // Authored labels and destinations keep their intentional CJK content.
        if (token.markup !== "linkify") {
          continue;
        }
        // Use the display text to find CJK boundary (href may be percent-encoded)
        const textToken = children[index + 1];
        if (!textToken || textToken.type !== "text") {
          continue;
        }
        const displayText = textToken.content;
        // Interior CJK stays in the URL (https://example.com/你/test).
        let cjkIndex = displayText.length;
        while (cjkIndex > 0 && CJK_RE.test(displayText.charAt(cjkIndex - 1))) {
          cjkIndex--;
        }
        if (cjkIndex <= 0 || cjkIndex === displayText.length) {
          continue;
        }
        const trimmedDisplay = displayText.slice(0, cjkIndex);
        const cjkTail = displayText.slice(cjkIndex);
        // Rebuild href by preserving the scheme prefix that linkify added but
        // display text omits (e.g. "mailto:" for emails, "http://" for www links).
        const href = String(token.attrGet("href") ?? "");
        const prefixLength = href.indexOf(displayText);
        const hrefPrefix = prefixLength > 0 ? href.slice(0, prefixLength) : "";
        token.attrSet("href", hrefPrefix + trimmedDisplay);
        textToken.content = trimmedDisplay;
        for (let closeIndex = index + 1; closeIndex < children.length; closeIndex++) {
          if (children[closeIndex]?.type === "link_close") {
            const tailToken = new state.Token("text", "", 0);
            tailToken.content = cjkTail;
            children.splice(closeIndex + 1, 0, tailToken);
            break;
          }
        }
      }
    }
  });

  markdownParser.core.ruler.after("linkify-cjk-trim", "file-links", (state) => {
    const env = state.env as Partial<MarkdownRenderEnv> | undefined;
    if (env?.fileLinks !== true) {
      return;
    }
    const decorations: MarkdownFileLinkDecoration[] = [];
    for (const blockToken of state.tokens) {
      if (blockToken.type !== "inline" || !blockToken.children) {
        continue;
      }
      const children = blockToken.children;
      let linkDepth = 0;
      for (let index = 0; index < children.length; index++) {
        const token = children[index];
        if (!token) {
          continue;
        }
        if (token.type === "link_open") {
          const href = String(token.attrGet("href") ?? "");
          if (href && !token.attrGet("data-session-href")) {
            let decodedHref = href;
            try {
              decodedHref = decodeURIComponent(href);
            } catch {
              // Keep the raw href when malformed percent escapes cannot be decoded.
            }
            if (!decodedHref.includes("://")) {
              const target =
                parseMarkdownFileLinkTarget(decodedHref, { authored: true }) ??
                (isHostLocalMarkdownFileHref(decodedHref)
                  ? splitMarkdownFileLineSuffix(decodedHref.trim())
                  : null);
              if (target) {
                token.attrs = token.attrs?.filter(([name]) => name !== "href") ?? null;
                token.attrJoin("class", "markdown-file-link");
                token.attrSet("role", "button");
                token.attrSet("tabindex", "0");
                token.attrSet("data-file-path", target.path);
                token.attrSet("data-file-kind", fileKindForPath(target.path));
                if (target.line !== null) {
                  token.attrSet("data-file-line", String(target.line));
                }
                // Keep authored labels; expose their reference only when different.
                const reference = decodedHref.trim();
                if (linkLabelText(children, index) !== reference) {
                  token.attrSet("title", reference);
                }
              }
            }
          }
          linkDepth += 1;
          continue;
        }
        if (token.type === "link_close") {
          linkDepth = Math.max(0, linkDepth - 1);
          continue;
        }
        if (linkDepth > 0) {
          continue;
        }
        if (token.type === "code_inline") {
          const target = parseMarkdownFileLinkTarget(token.content);
          if (target) {
            const reference = token.content.trim();
            const meta: MarkdownFileLinkMeta = {
              path: target.path,
              line: target.line,
              title: null,
            };
            token.meta = { ...token.meta, fileLink: meta };
            decorations.push({
              path: target.path,
              reference,
              applyLabel: (label) => {
                token.content = label;
                meta.title = label === reference ? null : reference;
              },
            });
          }
          continue;
        }
        if (token.type !== "text") {
          continue;
        }

        MARKDOWN_FILE_LINK_SCAN_RE.lastIndex = 0;
        index = replaceMarkdownTextMatches(
          state,
          children,
          index,
          MARKDOWN_FILE_LINK_SCAN_RE,
          (match) => {
            const matchIndex = match.index;
            const matched = match[0];
            const matchEnd = matchIndex + matched.length;
            if (!hasMarkdownLinkBoundaries(token.content, matchIndex, matchEnd)) {
              return null;
            }
            const target = parseMarkdownFileLinkTarget(matched);
            if (!target) {
              return null;
            }
            const open = new state.Token("link_open", "a", 1);
            open.markup = "file-link";
            open.attrSet("class", "markdown-file-link");
            open.attrSet("role", "button");
            open.attrSet("tabindex", "0");
            open.attrSet("data-file-path", target.path);
            open.attrSet("data-file-kind", fileKindForPath(target.path));
            if (target.line !== null) {
              open.attrSet("data-file-line", String(target.line));
            }
            const label = new state.Token("text", "", 0);
            label.content = matched;
            const close = new state.Token("link_close", "a", -1);
            close.markup = "file-link";
            decorations.push({
              path: target.path,
              reference: matched,
              applyLabel: (text) => {
                label.content = text;
                if (text !== matched) {
                  open.attrSet("title", matched);
                }
              },
            });
            return [open, label, close];
          },
        );
      }
    }
    // Colliding basenames retain enough trailing path segments to stay distinct.
    const labels = shortestFileLabels(decorations.map((decoration) => decoration.path));
    for (const decoration of decorations) {
      const label = labels.get(decoration.path) ?? decoration.path;
      // Line suffixes stay on the shortened label.
      decoration.applyLabel(label + decoration.reference.slice(decoration.path.length));
    }
  });

  installMarkdownSessionLinks(markdownParser);

  // Give bare and code-span GitHub URLs the same label; image-only links get no mark.
  markdownParser.core.ruler.after("linkify", "web-link-classes", (state) => {
    // SAFETY: markdown.ts supplies normalized, repository-scoped render options.
    const env = state.env as Partial<MarkdownRenderEnv> | undefined;
    const verifiedHosts = markdownGitHubHosts(env?.githubRepositories, env?.githubRepo);
    for (const blockToken of state.tokens) {
      if (blockToken.type !== "inline" || !blockToken.children) {
        continue;
      }
      const children = blockToken.children;
      let linkDepth = 0;
      for (let index = 0; index < children.length; index++) {
        let open = children[index];
        if (open?.type === "link_close") {
          linkDepth = Math.max(0, linkDepth - 1);
          continue;
        }
        if (open?.type === "code_inline" && linkDepth === 0) {
          // URL parsing absorbs whitespace/control characters, so reject mixed prose first.
          // CommonMark already removed symmetric code-span padding.
          const content = open.content;
          const codeUrl = CODE_SPAN_URL_BREAK_RE.test(content) ? null : parseWebLinkHref(content);
          if (!codeUrl || !isGitHubHost(codeUrl.hostname, verifiedHosts)) {
            continue;
          }
          const label = new state.Token("text", "", 0);
          label.content = content;
          open = new state.Token("link_open", "a", 1);
          open.markup = CODE_SPAN_LINK_MARKUP;
          open.attrSet("href", label.content);
          children.splice(index, 1, open, label, new state.Token("link_close", "a", -1));
        }
        if (open?.type !== "link_open") {
          continue;
        }
        linkDepth += 1;
        const href = String(open.attrGet("href") ?? "");
        const url = href ? parseWebLinkHref(href) : null;
        if (!url) {
          continue;
        }
        const generatedUrlLabel =
          open.markup === "linkify" ||
          open.markup === "autolink" ||
          open.markup === CODE_SPAN_LINK_MARKUP;
        const host = url.hostname.toLowerCase();
        const githubLink = isGitHubHost(host, verifiedHosts);
        const githubPreview = githubLink ? parseGitHubLinkTarget(href, verifiedHosts) : null;
        if (githubPreview) {
          open.attrJoin("class", MARKDOWN_GITHUB_PREVIEW_CLASS);
        }
        if (generatedUrlLabel) {
          open.attrJoin("class", BARE_URL_CLASS);
        }
        let labelToken: Token | null = null;
        for (let cursor = index + 1; cursor < children.length; cursor++) {
          const token = children[cursor];
          if (!token || token.type === "link_close") {
            break;
          }
          if (
            (token.type === "text" || token.type === "code_inline") &&
            token.content.trim() !== ""
          ) {
            labelToken = token;
            break;
          }
        }
        if (githubLink && labelToken) {
          open.attrJoin("class", GITHUB_LINK_CLASS);
          const item = githubPreview ?? parseGitHubItemPath(url);
          const label =
            labelToken.type === "text" &&
            children[index + 1] === labelToken &&
            children[index + 2]?.type === "link_close"
              ? labelToken.content
              : null;
          const itemChip =
            item &&
            (generatedUrlLabel ||
              label === `#${item.number}` ||
              label === `${item.owner}/${item.repo}#${item.number}`);
          if (itemChip) {
            open.attrJoin("class", "markdown-github-item");
            open.attrSet("data-github-kind", item.kind);
          }
          if (generatedUrlLabel) {
            labelToken.content = item ? `#${item.number}` : formatGitHubLinkLabel(url);
          }
          if (!githubPreview && (generatedUrlLabel || itemChip)) {
            open.attrSet("title", href);
          }
        }
        if (!githubLink && labelToken && state.env.linkFavicons) {
          const favicon = new state.Token("link_favicon", "img", 0);
          favicon.meta = { hostname: host };
          children.splice(index + 1, 0, favicon);
          index += 1;
        }
      }
    }
  });

  installMarkdownGitHubRefs(markdownParser);

  markdownParser.core.ruler.after("inline", "task-lists", (state) => {
    for (const [index, inline] of state.tokens.entries()) {
      const listItem = state.tokens[index - 2];
      const children = inline.children;
      const firstChild = children?.[0];
      if (
        inline.type !== "inline" ||
        state.tokens[index - 1]?.type !== "paragraph_open" ||
        listItem?.type !== "list_item_open" ||
        !/^\[[ xX]\] /.test(inline.content) ||
        !children ||
        !firstChild
      ) {
        continue;
      }
      // Task lists are display-only; labels would also wrap any links in the item.
      const checkbox = new state.Token("html_inline", "", 0);
      const checked = inline.content[1] !== " " ? ' checked=""' : "";
      checkbox.content = `<input class="task-list-item-checkbox"${checked} disabled="" type="checkbox">`;
      // Trust only the generated checkbox, including for transcript-role projection.
      checkbox.meta = { taskListPlugin: true };
      firstChild.content = firstChild.content.slice(3);
      children.unshift(checkbox);
      inline.content = inline.content.slice(3);
      listItem.attrSet("class", "task-list-item");
      for (let parent = index - 3; parent >= 0; parent--) {
        const token = state.tokens[parent];
        if (token?.level === listItem.level - 1) {
          token.attrSet("class", "contains-task-list");
          break;
        }
      }
    }
  });

  // Override html_block and html_inline to escape raw HTML (#13937). Progress-card
  // rendering strips non-progress HTML instead of exposing escaped tag text.
  // Only generated task-list checkboxes bypass escaping; DOMPurify still sanitizes them.
  markdownParser.renderer.rules.html_block = (tokens, index, _options, env) =>
    renderRawMarkdownHtml(tokens, index, env?.progressBars === true, true);
  markdownParser.renderer.rules.html_inline = (tokens, index, _options, env) => {
    const token = tokens[index];
    return token?.meta?.taskListPlugin === true
      ? token.content
      : renderRawMarkdownHtml(tokens, index, env?.progressBars === true, false);
  };
  markdownParser.renderer.rules.link_favicon = (tokens, index) => {
    const hostname: unknown = tokens[index]?.meta?.hostname;
    return typeof hostname === "string"
      ? `<img class="markdown-link-favicon" data-link-favicon-host="${escapeHtml(hostname)}" alt="" role="presentation">`
      : "";
  };
  markdownParser.renderer.rules.code_inline = (tokens, index, options, env, self) => {
    const rendered = defaultCodeInlineRenderer(tokens, index, options, env, self);
    const target = tokens[index]?.meta?.fileLink as MarkdownFileLinkMeta | undefined;
    if (target) {
      const lineAttribute =
        target.line === null ? "" : ` data-file-line="${escapeHtml(String(target.line))}"`;
      const titleAttribute = target.title === null ? "" : ` title="${escapeHtml(target.title)}"`;
      return `<a class="markdown-file-link" role="button" tabindex="0" data-file-path="${escapeHtml(target.path)}" data-file-kind="${fileKindForPath(target.path)}"${lineAttribute}${titleAttribute}>${rendered}</a>`;
    }
    return rendered;
  };

  // Fenced and indented blocks share one interaction and overflow surface.
  markdownParser.renderer.rules.fence = (tokens, index, _options, env) => {
    const token = tokens[index];
    if (!token) {
      return "";
    }
    const language = token.info.trim().split(/\s+/)[0] || "";
    // An unfinished fence consumes the remaining input; only container closers can
    // follow it. Invalid fence-looking prose must not de-highlight an earlier block.
    const openFence =
      env?.streamingOpenFence === true &&
      tokens.findLastIndex(({ nesting }) => nesting !== -1) === index;
    const code = renderMarkdownCodeBlock(token.content, language, env, {
      copyText: markdownCodeBlockCopyText(token.content),
      highlight: !openFence,
    });
    // Keep source readable until the host mounts the lazy renderer. Incomplete
    // streamed fences stay code so partial syntax never starts diagram layout.
    return language.toLowerCase() === "mermaid" && !openFence
      ? `<div class="markdown-mermaid">${code}</div>`
      : code;
  };
  markdownParser.renderer.rules.code_block = (tokens, index, _options, env) => {
    const content = tokens[index]?.content;
    if (content === undefined) {
      return "";
    }
    return renderMarkdownCodeBlock(content, "", env, {
      copyText: markdownCodeBlockCopyText(content),
    });
  };

  installMarkdownHumanMentions(markdownParser);
  return markdownParser;
}
