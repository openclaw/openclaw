/**
 * `@openclaw/oc-path/jsonc` — JSONC kind public surface.
 *
 * @module @openclaw/oc-path/jsonc
 */

export type { JsoncAst, JsoncEntry, JsoncValue } from './ast.js';
export type { JsoncParseResult } from './parse.js';
export { parseJsonc } from './parse.js';
export type { JsoncOcPathMatch } from './resolve.js';
export { resolveJsoncOcPath } from './resolve.js';
export type { JsoncEmitOptions } from './emit.js';
export { emitJsonc } from './emit.js';
export type { JsoncEditResult } from './edit.js';
export { setJsoncOcPath } from './edit.js';
