/**
 * JSONL parser — splits on `\n`, parses each non-empty line as JSONC
 * (allowing comments/trailing-comma is harmless and matches what
 * openclaw session logs actually emit). Soft-error policy: malformed
 * lines surface as `kind: 'malformed'` AST entries plus a diagnostic.
 *
 * @module @openclaw/oc-path/jsonl/parse
 */

import type { Diagnostic } from '../ast.js';
import { parseJsonc } from '../jsonc/parse.js';
import type { JsonlAst, JsonlLine } from './ast.js';

export interface JsonlParseResult {
  readonly ast: JsonlAst;
  readonly diagnostics: readonly Diagnostic[];
}

export function parseJsonl(raw: string): JsonlParseResult {
  const diagnostics: Diagnostic[] = [];
  // Trim trailing newline so we don't fabricate a blank line at EOF
  // for files that end with `\n` (which is most of them).
  const body = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const lines: JsonlLine[] = [];

  if (body.length === 0) {
    return { ast: { kind: 'jsonl', raw, lines }, diagnostics };
  }

  const parts = body.split('\n');
  parts.forEach((lineText, idx) => {
    const lineNo = idx + 1;
    if (lineText.trim().length === 0) {
      lines.push({ kind: 'blank', line: lineNo, raw: lineText });
      return;
    }
    const r = parseJsonc(lineText);
    if (r.ast.root === null) {
      lines.push({ kind: 'malformed', line: lineNo, raw: lineText });
      diagnostics.push({
        line: lineNo,
        message: `line ${lineNo} could not be parsed as JSON`,
        severity: 'warning',
        code: 'OC_JSONL_LINE_MALFORMED',
      });
      return;
    }
    lines.push({
      kind: 'value',
      line: lineNo,
      value: r.ast.root,
      raw: lineText,
    });
  });

  return { ast: { kind: 'jsonl', raw, lines }, diagnostics };
}
