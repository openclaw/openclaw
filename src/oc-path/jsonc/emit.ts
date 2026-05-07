/**
 * Emit a `JsoncAst` to bytes.
 *
 * **Round-trip mode (default)** returns `ast.raw` verbatim — this
 * preserves comments, formatting, and trailing whitespace exactly.
 * Production landing extends this with a comment-preserving
 * structural emitter (porting from `openclaw-workspace`); the
 * minimal prototype just round-trips raw and re-stringifies in
 * render mode (loses comments — render mode is for synthetic ASTs
 * built from scratch).
 *
 * **Sentinel guard**: every emitted byte sequence is scanned for the
 * `__OPENCLAW_REDACTED__` literal. Catch in `raw` for round-trip and
 * walk every emitted leaf in render.
 *
 * @module @openclaw/oc-path/jsonc/emit
 */

import { OcEmitSentinelError, REDACTED_SENTINEL } from '../sentinel.js';
import type { JsoncAst, JsoncValue } from './ast.js';

export interface JsoncEmitOptions {
  readonly mode?: 'roundtrip' | 'render';
  readonly fileNameForGuard?: string;
}

export function emitJsonc(ast: JsoncAst, opts: JsoncEmitOptions = {}): string {
  const mode = opts.mode ?? 'roundtrip';
  const guardPath = opts.fileNameForGuard ? `oc://${opts.fileNameForGuard}` : 'oc://';

  if (mode === 'roundtrip') {
    if (ast.raw.includes(REDACTED_SENTINEL)) {
      throw new OcEmitSentinelError(`${guardPath}/[raw]`);
    }
    return ast.raw;
  }

  // Render mode — synthesize JSON from the structural tree (loses
  // comments). Walk every leaf string for sentinel detection.
  if (ast.root === null) return '';
  return renderValue(ast.root, guardPath, []);
}

function renderValue(value: JsoncValue, guardPath: string, walked: readonly string[]): string {
  switch (value.kind) {
    case 'object': {
      const parts = value.entries.map(
        (e) =>
          `${JSON.stringify(e.key)}: ${renderValue(e.value, guardPath, [...walked, e.key])}`,
      );
      return `{ ${parts.join(', ')} }`;
    }
    case 'array': {
      const parts = value.items.map((v, i) =>
        renderValue(v, guardPath, [...walked, String(i)]),
      );
      return `[ ${parts.join(', ')} ]`;
    }
    case 'string': {
      if (value.value === REDACTED_SENTINEL) {
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
