import MarkdownIt, { type MarkdownIt as MarkdownItParser, type Token } from "markdown-it";
import markdownItCjkFriendly from "markdown-it-cjk-friendly";
import { escapeHtml } from "../../../src/shared/html-escape.js";
import { fileKindForPath, shortestFileLabels } from "./file-kind.ts";
import { isGitHubHost } from "./github-link-eligibility.ts";
import {
  decodeGitHubPathSegment,
  formatGitHubItemReference,
  parseGitHubItemPath,
} from "./github-link-target.ts";
import { installAssistantTranscriptRoleMarkdown } from "./markdown-assistant-transcript.ts";
import { markdownCodeBlockCopyText, renderMarkdownCodeBlock } from "./markdown-code-blocks.ts";
import { installMarkdownDetails } from "./markdown-details.ts";
import {
  isHostLocalMarkdownFileHref,
  MARKDOWN_FILE_LINK_SCAN_RE,
  parseMarkdownFileLinkTarget,
  parseMarkdownDocumentFileLinkTarget,
  splitMarkdownFileLineSuffix,
} from "./markdown-file-links.ts";
import { installMarkdownGitHubRefs } from "./markdown-github-refs.ts";
import { installMarkdownHumanMentions } from "./markdown-human-mentions.ts";
import { hasMarkdownLinkBoundaries } from "./markdown-link-boundary.ts";
import type { MarkdownRenderEnv } from "./markdown-render-options.ts";
import { installMarkdownSessionLinks } from "./markdown-session-links.ts";
import { installMarkdownTables } from "./markdown-tables.ts";
import {
  markdownInlineChildren,
  replaceMarkdownTextMatches,
} from "./markdown-text-replacements.ts";
import { installMarkdownWindowsPaths } from "./markdown-windows-paths.ts";

// formatAudioTranscriptForAgent stores this model-facing label in conversation history.
const AUDIO_TRANSCRIPT_PREFIX = '[Audio transcript (machine-generated, untrusted)]: "';

// Only #RRGGBB previews; shorter forms collide with issue/PR numbers like #2536.
const HEX_COLOR_RE = /#[\da-f]{6}(?![\da-f])/gi;

const DISALLOWED_LINK_SCHEME_RE = /^(?!(?:https?|mailto):)[a-z][a-z0-9+.-]*:/i;
// Raw CJK suffixes delimit autolinks; percent-encoded URL content stays intact.
const CJK_CHARACTER_RE =
  /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF01-\uFF60]/;

// CSS paints the decorative mark outside the accessibility tree and copied text.
const GITHUB_LINK_CLASS = "markdown-github-link";
// Only generated URL labels may wrap at any character.
const BARE_URL_CLASS = "markdown-bare-url";
const CODE_SPAN_URL_BREAK_RE = /[\s\p{Cc}]/u;
const FILE_REFERENCE_MARKER_RE = /[/\\:]/;

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

function decorateFileLink(token: Token, target: { path: string; line: number | null }): void {
  token.attrJoin("class", "markdown-file-link");
  token.attrSet("role", "button");
  token.attrSet("tabindex", "0");
  token.attrSet("data-file-path", target.path);
  token.attrSet("data-file-kind", fileKindForPath(target.path));
  if (target.line !== null) {
    token.attrSet("data-file-line", String(target.line));
  }
}

function parseWebLinkHref(href: string): URL | null {
  // Docs-relative rewriting runs later in markdown.ts.
  const url = URL.parse(href);
  return url?.protocol === "https:" || url?.protocol === "http:" ? url : null;
}

function formatGitHubLinkLabel(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  const path = segments.map((segment) => decodeGitHubPathSegment(segment) ?? segment);
  if (path.length === 2) {
    return path.join("/");
  }
  if ((segments[2] === "blob" || segments[2] === "tree") && segments.length > 4) {
    const basename = decodeGitHubPathSegment(segments.at(-1)!);
    if (basename) {
      // Tree refs may contain slashes; the omitted path is not just a folder.
      return segments[2] === "tree" ? path.slice(0, 2).join("/") + "/…/" + basename : basename;
    }
  }
  return ["github.com", ...path].join("/");
}

export function createMarkdownParser(): MarkdownItParser {
  const markdownParser = new MarkdownIt({
    html: true, // Enable HTML recognition so html_block/html_inline overrides can escape it
    breaks: true,
    linkify: true,
  });
  markdownParser.use(markdownItCjkFriendly);
  markdownParser.enable("strikethrough");
  markdownParser.block.ruler.before(
    "reference",
    "audio_transcript",
    (state, startLine, _endLine, silent) => {
      if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) {
        return false;
      }
      const start = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
      const end = state.eMarks[startLine] ?? state.src.length;
      const line = state.src.slice(start, end);
      if (!line.startsWith(AUDIO_TRANSCRIPT_PREFIX)) {
        return false;
      }
      if (silent) {
        return true;
      }
      // Without this presentation adapter, a transcript without spaces is a hidden
      // Markdown link definition. Keep the persisted and model-facing bytes intact.
      state.push("paragraph_open", "p", 1).map = [startLine, startLine + 1];
      const inline = state.push("inline", "", 0);
      inline.content = `\\${line}`;
      inline.map = [startLine, startLine + 1];
      inline.children = [];
      state.push("paragraph_close", "p", -1);
      state.line = startLine + 1;
      return true;
    },
    { alt: ["reference"] },
  );
  installAssistantTranscriptRoleMarkdown(markdownParser);
  installMarkdownDetails(markdownParser);
  installMarkdownTables(markdownParser);
  installMarkdownWindowsPaths(markdownParser);

  // Bare filenames such as README.md are not web destinations.
  markdownParser.linkify.set({ fuzzyLink: false });

  // A raw quote ends an HTTP URL in prose/JSON; encoded quotes remain URL data.
  // Bound the input before matching so native path and punctuation rules still apply.
  for (const schema of ["http:", "https:"]) {
    markdownParser.linkify.add(schema, {
      validate(text, pos, self) {
        const pattern = self.re.get_http_validator();
        const quote = text.indexOf('"', pos);
        pattern.lastIndex = pos;
        return pattern.exec(quote < 0 ? text : text.slice(0, quote))?.[0].length ?? 0;
      },
    });
  }

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

      // Count delimiters in one pass; suffix removal never rescans the URL.
      const counts: Record<string, number> = {};
      for (const character of match[0]) {
        counts[character] = (counts[character] ?? 0) + 1;
      }

      while (length > 0) {
        const character = tail.charAt(length - 1);
        if (/[?!.,:*_~]/.test(character)) {
          length--;
          continue;
        }
        // GFM entity reference rule: strip trailing &entity; sequences.
        if (character === ";") {
          const index = tail.lastIndexOf("&", length - 1);
          if (/^&[a-zA-Z0-9]+;$/.test(tail.slice(index, length))) {
            length = index;
            continue;
          }
          break;
        }
        const open = balancePairs[character];
        if (
          open !== undefined &&
          (open === character
            ? counts[character]! % 2 !== 0
            : counts[character]! > (counts[open] ?? 0))
        ) {
          counts[character]!--;
          length--;
          continue;
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

  markdownParser.core.ruler.after("linkify", "file-links", (state) => {
    const env = state.env as Partial<MarkdownRenderEnv>;
    const decorations: MarkdownFileLinkDecoration[] = [];
    const fileLinkTokens = (
      label: Token,
      target: { path: string; line: number | null },
      reference: string,
    ): Token[] => {
      const open = new state.Token("link_open", "a", 1);
      const close = new state.Token("link_close", "a", -1);
      open.markup = "file-link";
      close.markup = "file-link";
      decorateFileLink(open, target);
      decorations.push({
        path: target.path,
        reference,
        applyLabel: (text) => {
          label.content = text;
          if (text !== reference) {
            open.attrSet("title", reference);
          }
        },
      });
      return [open, label, close];
    };
    for (const children of markdownInlineChildren(state.tokens)) {
      // Markdown links cannot nest; the opening token owns both wrapper states.
      let openLink: Token | undefined;
      for (let index = 0; index < children.length; index++) {
        const token = children[index];
        if (!token) {
          continue;
        }
        if (token.type === "link_open") {
          const href = String(token.attrGet("href") ?? "");
          if (
            href &&
            (env.fileLinks || env.documentFileLinks) &&
            !token.attrGet("data-session-href") &&
            !token.attrGet("data-template-package")
          ) {
            let decodedHref = href;
            try {
              decodedHref = decodeURIComponent(href);
            } catch {
              // Keep the raw href when malformed percent escapes cannot be decoded.
            }
            // Query values may contain URLs; selection parsing owns the destination's scheme check.
            if (env.documentFileLinks === "select" || !decodedHref.includes("://")) {
              const documentTarget = env.documentFileLinks
                ? parseMarkdownDocumentFileLinkTarget(
                    href,
                    env.documentFileLinks === "select" ? "select" : "read",
                  )
                : null;
              const target =
                documentTarget ??
                (env.fileLinks
                  ? (parseMarkdownFileLinkTarget(decodedHref, { authored: true }) ??
                    (isHostLocalMarkdownFileHref(decodedHref)
                      ? splitMarkdownFileLineSuffix(decodedHref.trim())
                      : null))
                  : null);
              if (target) {
                token.attrs = token.attrs?.filter(([name]) => name !== "href") ?? null;
                decorateFileLink(token, target);
                if (documentTarget) {
                  token.attrSet("data-file-document-relative", "true");
                }
                // Keep authored labels; expose their reference only when different.
                const reference = decodedHref.trim();
                if (linkLabelText(children, index) !== reference) {
                  token.attrSet("title", reference);
                }
              }
            }
          }
          // Local file decoration removes hrefs such as C:/notes.md before scheme rejection.
          token.hidden = DISALLOWED_LINK_SCHEME_RE.test(String(token.attrGet("href") ?? ""));
          openLink = token;
          continue;
        }
        if (token.type === "link_close") {
          token.hidden = openLink?.hidden ?? false;
          openLink = undefined;
          continue;
        }
        if (openLink || !env.fileLinks) {
          continue;
        }
        if (token.type === "code_inline") {
          const target = parseMarkdownFileLinkTarget(token.content);
          if (target) {
            children.splice(index, 1, ...fileLinkTokens(token, target, token.content.trim()));
            index += 2;
          }
          continue;
        }
        // Prose references need a path separator or a bare filename's :line suffix.
        if (token.type !== "text" || !FILE_REFERENCE_MARKER_RE.test(token.content)) {
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
            const label = new state.Token("text", "", 0);
            return fileLinkTokens(label, target, matched);
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

  // One link pass owns URL labels and source-footer labels alike.
  markdownParser.core.ruler.after("linkify", "web-link-classes", (state) => {
    const paragraph = state.tokens.at(-3);
    const tail = state.tokens.at(-2);
    for (const children of markdownInlineChildren(state.tokens)) {
      let footer =
        state.env.mode === "message" &&
        !state.env.streamingPrefix &&
        paragraph?.type === "paragraph_open" &&
        paragraph.level === 0 &&
        tail?.children === children;
      const links = [];
      const repositories = new Set<string>();
      let items = 0;
      for (let index = 0; index < children.length; index++) {
        let open = children[index]!;
        if (open.type === "code_inline") {
          // URL parsing absorbs whitespace/control characters; reject mixed prose first.
          const content = open.content;
          const url = CODE_SPAN_URL_BREAK_RE.test(content) ? null : parseWebLinkHref(content);
          if (url && isGitHubHost(url.hostname)) {
            const label = new state.Token("text", "", 0);
            label.content = content;
            open = new state.Token("link_open", "a", 1);
            open.markup = "autolink";
            open.attrSet("href", content);
            children.splice(index, 1, open, label, new state.Token("link_close", "a", -1));
          }
        }
        if (open.type !== "link_open") {
          footer &&=
            open.type === "softbreak" ||
            open.type === "hardbreak" ||
            (open.type === "text" && /^[\s,·]*$/u.test(open.content));
          continue;
        }
        let end = index + 1;
        let label: Token | undefined;
        while (children[end]!.type !== "link_close") {
          const token = children[end]!;
          footer &&= token.type !== "image";
          if (
            !label &&
            (token.type === "text" || token.type === "code_inline") &&
            token.content.trim()
          ) {
            label = token;
          }
          end++;
        }
        const href = String(open.attrGet("href") ?? "");
        const url = parseWebLinkHref(href);
        const github = url && isGitHubHost(url.hostname);
        if (url && !github && label && state.env.linkFavicons) {
          const favicon = new state.Token("link_favicon", "img", 0);
          favicon.meta = { hostname: url.hostname };
          children.splice(index + 1, 0, favicon);
          end++;
        }
        const content = children.slice(index, end + 1);
        footer &&= Boolean(url);
        if (url) {
          const item = github ? parseGitHubItemPath(url) : null;
          links.push({ content, url, label, item });
          if (item && url.href.startsWith("https://github.com/")) {
            items++;
            repositories.add(`${item.owner}/${item.repo}`.toLowerCase());
          }
        }
        index = end;
      }
      footer &&= items >= 2;
      if (footer) {
        children.length = 0;
      }
      const comma = new state.Token("text", "", 0);
      comma.content = ", ";
      for (const { content, url, item, label } of links) {
        const open = content[0]!;
        const github = isGitHubHost(url.hostname);
        const generated = ["linkify", "autolink"].includes(open.markup);
        if (generated) {
          open.attrJoin("class", BARE_URL_CLASS);
        }
        const preview = item && url.href.startsWith("https://github.com/");
        const compact = footer && links.length >= 5 && preview;
        if (github && label) {
          open.attrJoin("class", GITHUB_LINK_CLASS);
          const reference = item ? formatGitHubItemReference(item) : "";
          const chip =
            item &&
            (compact ||
              generated ||
              (content.length === 3 &&
                label.type === "text" &&
                [`#${item.number}`, reference].includes(label.content)));
          if (chip) {
            open.attrJoin("class", "markdown-github-item");
            open.attrSet("data-github-kind", item.kind);
            if (compact) {
              const title = content.map((token) => token.content).join("");
              label.type = "text";
              label.tag = "";
              content.splice(1, content.length - 2, label);
              label.content = repositories.size === 1 ? `#${item.number}` : reference;
              open.attrSet("aria-label", `${label.content}: ${title}`);
            } else {
              label.content = reference;
            }
          } else if (generated) {
            label.content = formatGitHubLinkLabel(url);
          }
          if (!preview && (generated || chip)) {
            open.attrSet("title", String(open.attrGet("href")));
          }
        }
        if (footer) {
          if (children.length) {
            children.push(comma);
          }
          children.push(...content);
        }
      }
      // Keep CJK trimming after URL labeling, before session/file decoration.
      for (let index = 0; index < children.length; index++) {
        const token = children[index]!;
        // Linkify emits open/text/close triples; authored links are not normalized.
        if (token.type !== "link_open" || token.markup !== "linkify") {
          continue;
        }
        const textToken = children[index + 1]!;
        const displayText = textToken.content;
        let end = displayText.length;
        while (end > 0 && CJK_CHARACTER_RE.test(displayText[end - 1]!)) {
          end--;
        }
        if (end === 0 || end === displayText.length) {
          continue;
        }
        const trimmed = displayText.slice(0, end);
        const href = String(token.attrGet("href") ?? "");
        const prefix = href.indexOf(displayText);
        token.attrSet("href", (prefix > 0 ? href.slice(0, prefix) : "") + trimmed);
        textToken.content = trimmed;
        const suffixToken = new state.Token("text", "", 0);
        suffixToken.content = displayText.slice(end);
        children.splice(index + 3, 0, suffixToken);
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
      ? `<img class="markdown-link-favicon" data-link-favicon-host="${escapeHtml(hostname)}" width="16" height="16" loading="lazy" decoding="async" alt="" role="presentation">`
      : "";
  };
  // Fenced and indented blocks share one interaction and overflow surface.
  markdownParser.renderer.rules.fence = markdownParser.renderer.rules.code_block = (
    tokens,
    index,
    _options,
    env,
  ) => {
    const token = tokens[index];
    if (!token) {
      return "";
    }
    const fenced = token.type === "fence";
    const language = fenced ? token.info.trim().split(/\s+/)[0] || "" : "";
    // An unfinished fence consumes the remaining input; only container closers can
    // follow it. Invalid fence-looking prose must not de-highlight an earlier block.
    const openFence =
      fenced &&
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
  installMarkdownHumanMentions(markdownParser);
  // Link owners run first; preserve reference metadata before text tokens are joined.
  markdownParser.core.ruler.before("text_join", "hex-colors", (state) => {
    if (state.env.mode !== "message") {
      return;
    }
    for (const children of markdownInlineChildren(state.tokens)) {
      let linkDepth = 0;
      for (let index = 0; index < children.length; index += 1) {
        const token = children[index]!;
        if (token.type === "link_open" || token.type === "link_close") {
          linkDepth += token.nesting;
        }
        if (
          token.type !== "text" ||
          token.meta?.githubItemReference ||
          linkDepth !== 0 ||
          !token.content.includes("#")
        ) {
          continue;
        }
        index = replaceMarkdownTextMatches(state, children, index, HEX_COLOR_RE, (match) => {
          const end = match.index + match[0].length;
          if (
            !hasMarkdownLinkBoundaries(token.content, match.index, end) ||
            /^[.-]\w/u.test(token.content.slice(end))
          ) {
            return null;
          }
          const color = new state.Token("hex_color", "", 0);
          color.content = match[0];
          return [color];
        });
      }
    }
  });
  markdownParser.renderer.rules.hex_color = (tokens, index) => {
    const color = tokens[index]!.content;
    // Only the validated hex token enters this image; no style or HTML allowlist expansion.
    const image = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="${color}" d="M0 0h16v16H0z"/></svg>`,
    );
    return `<span class="markdown-hex-color"><img class="markdown-hex-color__swatch" src="data:image/svg+xml,${image}" alt="" aria-hidden="true">${color}</span>`;
  };
  return markdownParser;
}
