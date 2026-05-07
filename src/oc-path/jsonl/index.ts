/**
 * `@openclaw/oc-path/jsonl` — JSONL kind public surface.
 *
 * @module @openclaw/oc-path/jsonl
 */

export type { JsonlAst, JsonlLine } from './ast.js';
export type { JsonlParseResult } from './parse.js';
export { parseJsonl } from './parse.js';
export type { JsonlOcPathMatch } from './resolve.js';
export { resolveJsonlOcPath } from './resolve.js';
export type { JsonlEmitOptions } from './emit.js';
export { emitJsonl } from './emit.js';
export type { JsonlEditResult } from './edit.js';
export { setJsonlOcPath, appendJsonlOcPath } from './edit.js';
