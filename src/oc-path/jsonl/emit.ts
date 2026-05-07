/**
 * Emit a `JsonlAst` to bytes.
 *
 * **Round-trip mode (default)** returns `ast.raw` verbatim — preserves
 * malformed lines, blanks, trailing-newline shape exactly.
 *
 * **Render mode** rebuilds the file from line entries (re-stringifies
 * value lines via JSON.stringify; preserves blank/malformed lines
 * verbatim). Useful for synthetic ASTs.
 *
 * **Sentinel guard**: scans every emitted byte sequence for the
 * `__OPENCLAW_REDACTED__` literal.
 *
 * @module @openclaw/oc-path/jsonl/emit
 */

import { OcEmitSentinelError, REDACTED_SENTINEL } from '../sentinel.js';
import type { JsoncValue } from '../jsonc/ast.js';
import type { JsonlAst } from './ast.js';

export interface JsonlEmitOptions {
  readonly mode?: 'roundtrip' | 'render';
  readonly fileNameForGuard?: string;
}

export function emitJsonl(ast: JsonlAst, opts: JsonlEmitOptions = {}): string {
  const mode = opts.mode ?? 'roundtrip';
  const guardPath = opts.fileNameForGuard ? `oc://${opts.fileNameForGuard}` : 'oc://';

  if (mode === 'roundtrip') {
    if (ast.raw.includes(REDACTED_SENTINEL)) {
      throw new OcEmitSentinelError(`${guardPath}/[raw]`);
    }
    return ast.raw;
  }

  const out: string[] = [];
  for (const ln of ast.lines) {
    if (ln.kind === 'blank' || ln.kind === 'malformed') {
      if (ln.raw.includes(REDACTED_SENTINEL)) {
        throw new OcEmitSentinelError(`${guardPath}/L${ln.line}`);
      }
      out.push(ln.raw);
      continue;
    }
    out.push(renderValue(ln.value, `${guardPath}/L${ln.line}`, []));
  }
  return out.join('\n');
}

function renderValue(value: JsoncValue, guardPath: string, walked: readonly string[]): string {
  switch (value.kind) {
    case 'object': {
      const parts = value.entries.map(
        (e) => `${JSON.stringify(e.key)}:${renderValue(e.value, guardPath, [...walked, e.key])}`,
      );
      return `{${parts.join(',')}}`;
    }
    case 'array': {
      const parts = value.items.map((v, i) =>
        renderValue(v, guardPath, [...walked, String(i)]),
      );
      return `[${parts.join(',')}]`;
    }
    case 'string': {
      // Reject ANY string that contains the sentinel — embedded
      // (`prefix__OPENCLAW_REDACTED__suffix`) is just as much of a
      // "literal redacted token landed on disk" leak as exact-match.
      if (value.value.includes(REDACTED_SENTINEL)) {
        throw new OcEmitSentinelError(`${guardPath}/${walked.join('/')}`);
      }
      return JSON.stringify(value.value);
    }
    case 'number':
      return String(value.value);
    case 'boolean':
      return String(value.value);
    case 'null':
      return 'null';
  }
}
