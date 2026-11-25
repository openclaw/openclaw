// Lazy tree-sitter runtime caches the bash parser and enforces source-size/time
// limits for command explanation.
import { createRequire } from "node:module";
import type * as TreeSitter from "web-tree-sitter";

const require = createRequire(import.meta.url);

export type BashCommandParser = (source: string) => TreeSitter.Tree;

let parserPromise: Promise<BashCommandParser> | null = null;
const MAX_COMMAND_EXPLANATION_SOURCE_CHARS = 128 * 1024;
const MAX_COMMAND_EXPLANATION_PARSE_MS = 500;

async function loadParser(): Promise<BashCommandParser> {
  const TreeSitter = await import("web-tree-sitter");
  await TreeSitter.Parser.init();
  const language = await TreeSitter.Language.load(
    require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"),
  );
  return parseBashForCommandExplanation.bind(null, new TreeSitter.Parser().setLanguage(language));
}

/** Callers own each returned tree and must delete it before yielding. */
export function getBashParserForCommandExplanation(): Promise<BashCommandParser> {
  // Reset the cache on load failure so transient filesystem or WASM init errors
  // do not poison all later command explanations in the process.
  parserPromise ??= loadParser().catch((error: unknown) => {
    parserPromise = null;
    throw error;
  });
  return parserPromise;
}

function parseBashForCommandExplanation(
  parser: TreeSitter.Parser,
  source: string,
): TreeSitter.Tree {
  if (source.length > MAX_COMMAND_EXPLANATION_SOURCE_CHARS) {
    throw new Error("Shell command is too large to explain");
  }
  const deadlineMs = performance.now() + MAX_COMMAND_EXPLANATION_PARSE_MS;
  let timedOut = false;
  const tree = parser.parse(source, null, {
    progressCallback: () => {
      timedOut = performance.now() > deadlineMs;
      return timedOut;
    },
  });
  if (!tree) {
    parser.reset();
    if (timedOut) {
      throw new Error(
        `tree-sitter-bash timed out after ${MAX_COMMAND_EXPLANATION_PARSE_MS}ms while parsing shell command`,
      );
    }
    throw new Error("tree-sitter-bash returned no parse tree");
  }
  return tree;
}
