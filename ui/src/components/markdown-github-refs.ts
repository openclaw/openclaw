import type { MarkdownIt, Token } from "markdown-it";
import { hasMarkdownLinkBoundaries } from "./markdown-link-boundary.ts";
import { replaceMarkdownTextMatches } from "./markdown-text-replacements.ts";

// Keep item numbers aligned with parseGitHubItemPath; short numbers need a keyword.
// A trailing `.` or `-` only disqualifies when it continues into a word (`#12.txt`,
// `#12-rc`), so a reference that ends a sentence still links.
// An identifier boundary avoids rescanning each suffix of long unqualified words.
const GITHUB_ITEM_REF_RE =
  /(?<![A-Za-z0-9_.-])(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9]\d{0,9})(?!\w|[.-]\w)/g;
const GITHUB_ITEM_KEYWORD_RE = /(PR|pull request|pull|issue|fixes|closes|resolves)\s+$/i;

function qualifiedRepository(prefix: string) {
  const match = /(?:^|[\s([{"'])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(prefix);
  if (!match || [match[1], match[2]].some((part) => part === "." || part === "..")) {
    return null;
  }
  return {
    repository: { owner: match[1]!, repo: match[2]! },
    length: match[1]!.length + match[2]!.length + 1,
  };
}

function referenceTextContexts(children: readonly Token[]) {
  const contexts = new Map<
    Token,
    { run: { content: string; scannedTo: number }; offset: number }
  >();
  let run = { content: "", scannedTo: 0 };
  let linkDepth = 0;
  for (const token of children) {
    if (token.type === "link_open") {
      linkDepth++;
    } else if (token.type === "link_close") {
      linkDepth--;
    }
    if (linkDepth === 0 && token.type === "text") {
      contexts.set(token, { run, offset: run.content.length });
      run.content += token.content;
    } else if (!/^(?:em|strong)_(?:open|close)$/.test(token.type)) {
      // Formatting is transparent to reference semantics, but links, code,
      // images, and line breaks must not lend their text to a nearby keyword.
      run = { content: "", scannedTo: 0 };
    }
  }
  return contexts;
}

export function installMarkdownGitHubRefs(markdownParser: MarkdownIt): void {
  markdownParser.core.ruler.before("web-link-classes", "github-item-refs", (state) => {
    let inHeading = false;
    for (const blockToken of state.tokens) {
      if (blockToken.type === "heading_open") {
        inHeading = true;
      } else if (blockToken.type === "heading_close") {
        inHeading = false;
      }
      const children = blockToken.children;
      if (inHeading || blockToken.type !== "inline" || !children) {
        continue;
      }
      const contexts = referenceTextContexts(children);
      for (let index = 0; index < children.length; index++) {
        const token = children[index];
        if (!token) {
          continue;
        }
        const context = contexts.get(token);
        if (context) {
          index = replaceMarkdownTextMatches(
            state,
            children,
            index,
            GITHUB_ITEM_REF_RE,
            (match) => {
              const number = match[2];
              if (!number) {
                return null;
              }
              const end = match.index + match[0].length;
              const referenceStart = match.index;
              const startInRun = context.offset + referenceStart;
              const endInRun = context.offset + end;
              const content = context.run.content;
              const preceding = content.slice(context.run.scannedTo, startInRun);
              const direct = qualifiedRepository(match[1] ?? preceding);
              if (match[1] && !direct) {
                return null;
              }
              const keywordEnd = direct && !match[1] ? startInRun - direct.length : startInRun;
              const prefix = content
                .slice(context.run.scannedTo, keywordEnd)
                .match(GITHUB_ITEM_KEYWORD_RE);
              // A prior number cannot be part of the next adjacent keyword.
              context.run.scannedTo = endInRun;
              const keyword =
                prefix &&
                hasMarkdownLinkBoundaries(content, keywordEnd - prefix[0].length, endInRun)
                  ? prefix[1]
                  : undefined;
              if (
                (!keyword && !direct && number.length < 4) ||
                !hasMarkdownLinkBoundaries(content, keywordEnd, endInRun) ||
                /^[.-]\w/.test(content.slice(endInRun))
              ) {
                return null;
              }
              const kind = keyword && /^(?:pr|pull)/i.test(keyword) ? "pull" : "issue";
              const repository =
                direct?.repository ??
                (keyword
                  ? qualifiedRepository(preceding.slice(0, -prefix![0].length).trimEnd())
                      ?.repository
                  : undefined);
              if (!repository) {
                if (!keyword) {
                  return null;
                }
                const reference = new state.Token("text", "", 0);
                reference.content = match[0];
                // Preserve the reference's meaning for later inline decorators.
                reference.meta = { githubItemReference: true };
                return [reference];
              }
              const base = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
              const path = kind === "pull" ? "pull" : "issues";
              const open = new state.Token("link_open", "a", 1);
              open.attrSet("href", `${base}/${path}/${number}`);
              const label = new state.Token("text", "", 0);
              label.content = `#${number}`;
              return [open, label, new state.Token("link_close", "a", -1)];
            },
          );
        }
      }
    }
  });
}
