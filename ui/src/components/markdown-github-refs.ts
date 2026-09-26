import type { MarkdownIt, Token } from "markdown-it";
import {
  markdownGitHubAliases,
  type MarkdownGitHubAliases,
  type MarkdownGitHubRepository,
} from "./markdown-github-repositories.ts";
import { hasMarkdownLinkBoundaries } from "./markdown-link-boundary.ts";
import type { MarkdownRenderEnv } from "./markdown-render-options.ts";
import { replaceMarkdownTextMatches } from "./markdown-text-replacements.ts";

// Keep item numbers aligned with parseGitHubItemPath; short numbers need a keyword.
// A trailing `.` or `-` only disqualifies when it continues into a word (`#12.txt`,
// `#12-rc`), so a reference that ends a sentence still links.
const GITHUB_ITEM_REF_RE = /#([1-9]\d{0,9})(?!\w|[.-]\w)/g;
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

function knownAlias(prefix: string, aliases: MarkdownGitHubAliases, latestStart = prefix.length) {
  const normalized = prefix.toLowerCase();
  const lastStart = prefix.slice(0, latestStart).toLowerCase().length;
  return aliases
    .filter(([alias]) => {
      const start = normalized.lastIndexOf(alias);
      return (
        start >= 0 &&
        start <= lastStart &&
        /^[,:\])]*$/u.test(normalized.slice(start + alias.length)) &&
        !/[\p{L}\p{N}_./-]/u.test(normalized[start - 1] ?? "")
      );
    })
    .toSorted(([left], [right]) => right.length - left.length)[0];
}

function referenceRepository(
  prefix: string,
  aliases: MarkdownGitHubAliases,
  fallback?: MarkdownGitHubRepository | null,
): MarkdownGitHubRepository | null | undefined {
  const raw = prefix.trimEnd();
  const tail = raw.replace(/[,:\])]+$/u, "").trimEnd();
  const quotes = /(?:^|[\s([{])(?:"(.*)"|'(.*)'|“(.*)”|‘(.*)’)$/u.exec(tail);
  const quoted = quotes?.slice(1).find((value) => value !== undefined);
  const introduced = /\b(?:repo(?:sitory)?|project)\s*[:=]?\s+([^;!?]+)$/iu.exec(raw)?.[1];
  const name = quoted ?? introduced;
  const qualifier = (name ?? tail).trim();
  const explicit = qualifiedRepository(qualifier);
  if (explicit && (name === undefined || explicit.length === qualifier.length)) {
    return explicit.repository;
  }
  // Prefer complete known names before treating their punctuation as a wrapper.
  // A known suffix inside a quoted/introduced unknown name is not that identity.
  const latestStart =
    quoted !== undefined
      ? tail.length - quoted.length - 2
      : introduced !== undefined
        ? raw.length - introduced.length
        : raw.length;
  const rawMatch = knownAlias(raw, aliases, latestStart);
  if (rawMatch) {
    return rawMatch[1];
  }
  if (name !== undefined) {
    return aliases.find(([alias]) => alias === qualifier.toLowerCase())?.[1] ?? null;
  }
  // Syntactic identifiers claim a repository, unlike ordinary Original/Follow-up prose.
  const lastWord = qualifier.match(/[^\s([{]+$/u)?.[0] ?? "";
  return /[a-z][A-Z]|\w[._]\w|\/|["'’”]$/u.test(lastWord) ? null : fallback;
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
    // SAFETY: markdown.ts supplies normalized render options as markdown-it's untyped env.
    const env = state.env as Partial<MarkdownRenderEnv> | undefined;
    const aliases = markdownGitHubAliases(env?.githubRepositories, env?.githubRepo);
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
              const number = match[1];
              if (!number) {
                return null;
              }
              const end = match.index + match[0].length;
              const referenceStart = match.index;
              const startInRun = context.offset + referenceStart;
              const endInRun = context.offset + end;
              const content = context.run.content;
              const preceding = content.slice(context.run.scannedTo, startInRun);
              const direct = qualifiedRepository(preceding);
              const keywordEnd = direct ? startInRun - direct.length : startInRun;
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
              const repository =
                direct?.repository ??
                (keyword
                  ? referenceRepository(
                      preceding.slice(0, -prefix![0].length),
                      aliases,
                      env?.githubRepo,
                    )
                  : env?.githubRepo);
              if (!repository) {
                return null;
              }
              const base = `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
              const path = keyword && /^(?:pr|pull)/i.test(keyword) ? "pull" : "issues";
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
