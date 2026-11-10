import { foldNodeProp } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { loadCodeLanguage } from "../../../components/code-language.ts";
import type { DiffSyntaxFold } from "../../../lib/chat/session-diff-folds.ts";
import type { DiffLine } from "../../../lib/chat/tool-call-diff.ts";

// Syntax is optional decoration; keep oversized/minified diffs readable without
// synchronously parsing an unbounded source string on the UI thread.
const MAX_HIGHLIGHT_CHARS = 120_000;

export type DiffHighlightToken = { text: string; classes: string };

// A retained disclosure marker is transparent only when its complete numbered context follows it.
function isRevealedGap(lines: readonly DiffLine[], index: number): boolean {
  const gap = lines[index]?.gap;
  if (!gap || gap.count < 1 || gap.count > lines.length - index - 1) {
    return false;
  }
  for (let offset = 0; offset < gap.count; offset++) {
    const line = lines[index + offset + 1]!;
    if (line.kind !== "ctx" || line.lineNo !== gap.newStart + offset) {
      return false;
    }
  }
  return true;
}

export async function analyzeDiffSyntax(lines: readonly DiffLine[], path: string, oldPath = path) {
  const highlighted = new Map<DiffLine, DiffHighlightToken[]>();
  const folds: DiffSyntaxFold[] = [];
  let size = 0;
  for (const line of lines) {
    size += line.text.length + 1;
    if (size > MAX_HIGHLIGHT_CHARS) {
      return { highlighted, folds };
    }
  }
  let section: { path: string; oldPath: string; lines: DiffLine[] } = { path, oldPath, lines: [] };
  const sections: (typeof section)[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.kind === "skip" && isRevealedGap(lines, index)) {
      continue;
    }
    if (line.kind === "file" || line.kind === "skip") {
      sections.push(section);
      section =
        line.kind === "file"
          ? { path: line.path ?? "", oldPath: line.oldPath ?? line.path ?? "", lines: [] }
          : { ...section, lines: [] };
    } else {
      section.lines.push(line);
    }
  }
  sections.push(section);
  await Promise.all(
    sections.map(async (part) => {
      if (!part.lines.length) {
        return;
      }
      // Parse each side independently so deleted comments/strings cannot color
      // added code. Renames retain each language; shared context uses the new side.
      // A gap starts a new parse: omitted source is unknown.
      for (const excluded of ["add", "del"]) {
        const support = await loadCodeLanguage(excluded === "add" ? part.oldPath : part.path);
        if (!support) {
          continue;
        }
        const side = part.lines.filter((line) => line.kind !== excluded);
        const code = side.map((line) => line.text).join("\n");
        const tokens: DiffHighlightToken[][] = [[]];
        const tree = support.language.parser.parse(code);
        const state = EditorState.create({ doc: code });
        const candidates: {
          from: number;
          to: number;
          function: boolean;
          nodeFrom: number;
          nodeTo: number;
        }[] = [];
        const errors: number[] = [];
        tree.iterate({
          enter(node) {
            if (node.type.isError) {
              errors.push(node.from);
            }
            const fold = node.type.prop(foldNodeProp)?.(node.node, state);
            if (fold) {
              candidates.push({
                ...fold,
                nodeFrom: node.from,
                nodeTo: node.to,
                function:
                  /Function|Method|Class/.test(node.name) ||
                  /Function|Method|Class/.test(node.node.parent?.name ?? ""),
              });
            }
          },
        });
        // Recovery nodes cannot certify a complete block in a partial hunk.
        errors.sort((a, b) => a - b);
        for (const candidate of candidates) {
          let low = 0,
            high = errors.length;
          while (low < high) {
            const mid = (low + high) >>> 1;
            if (errors[mid]! < candidate.nodeFrom) {
              low = mid + 1;
            } else {
              high = mid;
            }
          }
          if (low < errors.length && errors[low]! <= candidate.nodeTo) {
            continue;
          }
          // We remove whole DOM rows, not text spans. Do not conceal a sibling
          // statement or an enclosing delimiter that shares the closing line.
          const endLine = state.doc.lineAt(candidate.nodeTo);
          // A zero-width dedent can end a body at the next physical line.
          const nodeEnd =
            candidate.nodeTo > 0 && candidate.nodeTo === endLine.from
              ? candidate.nodeTo - 1
              : candidate.nodeTo;
          const ending = state.doc.lineAt(nodeEnd);
          if (!/^[;,\s]*$/u.test(code.slice(nodeEnd, ending.to))) {
            continue;
          }
          const from = state.doc.lineAt(candidate.from).number - 1;
          const to = state.doc.lineAt(candidate.to).number - 1;
          if (to > from && side[from] && side[to]) {
            folds.push({
              start: side[from]!,
              end: side[to]!,
              side: excluded === "add" ? "old" : "new",
              function: candidate.function,
            });
          }
        }
        highlightCode(
          code,
          tree,
          classHighlighter,
          (text, classes) => tokens.at(-1)!.push({ text, classes }),
          () => {
            tokens.push([]);
          },
        );
        side.forEach((line, index) => {
          if (line.text && (excluded === "del" || line.kind === "del")) {
            highlighted.set(line, tokens[index]!);
          }
        });
      }
    }),
  );
  return { highlighted, folds };
}
