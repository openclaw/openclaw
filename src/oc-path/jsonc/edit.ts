/**
 * Mutate a `JsoncAst` at an OcPath. Returns a new AST with the value
 * replaced; the original AST is unchanged.
 *
 * **Why immutable**: callers can hold the pre-edit AST for diffing /
 * audit while applying the edit. Plays well with LKG observe (compare
 * pre vs post fingerprints).
 *
 * **Round-trip implications**: editing breaks `ast.raw` byte-fidelity
 * for the edited region. Callers that care about formatting fidelity
 * should pair `setJsoncOcPath` with `emitJsonc(..., { mode: 'render' })`.
 *
 * @module @openclaw/oc-path/jsonc/edit
 */

import type { OcPath } from '../oc-path.js';
import type { JsoncAst, JsoncEntry, JsoncValue } from './ast.js';
import { emitJsonc } from './emit.js';

export type JsoncEditResult =
  | { readonly ok: true; readonly ast: JsoncAst }
  | { readonly ok: false; readonly reason: 'unresolved' | 'no-root' };

/**
 * Replace the value at `path` with `newValue`. Returns the new AST or
 * a structured failure reason. Numeric segments index into arrays.
 */
export function setJsoncOcPath(
  ast: JsoncAst,
  path: OcPath,
  newValue: JsoncValue,
): JsoncEditResult {
  if (ast.root === null) return { ok: false, reason: 'no-root' };

  const segments: string[] = [];
  if (path.section !== undefined) segments.push(...path.section.split('.'));
  if (path.item !== undefined) segments.push(...path.item.split('.'));
  if (path.field !== undefined) segments.push(...path.field.split('.'));

  // Empty path — replace the root.
  if (segments.length === 0) {
    const next = { ...ast, root: newValue };
    return { ok: true, ast: rebuildRaw(next) };
  }

  const replaced = replaceAt(ast.root, segments, 0, newValue);
  if (replaced === null) return { ok: false, reason: 'unresolved' };
  const next = { ...ast, root: replaced };
  return { ok: true, ast: rebuildRaw(next) };
}

function replaceAt(
  current: JsoncValue,
  segments: readonly string[],
  i: number,
  newValue: JsoncValue,
): JsoncValue | null {
  const seg = segments[i];
  if (seg === undefined) return newValue;
  if (seg.length === 0) return null;

  if (current.kind === 'object') {
    const idx = current.entries.findIndex((e) => e.key === seg);
    if (idx === -1) return null;
    const child = current.entries[idx];
    if (child === undefined) return null;
    const replacedChild = replaceAt(child.value, segments, i + 1, newValue);
    if (replacedChild === null) return null;
    const newEntry: JsoncEntry = { ...child, value: replacedChild };
    const newEntries = current.entries.slice();
    newEntries[idx] = newEntry;
    return {
      kind: 'object',
      entries: newEntries,
      ...(current.line !== undefined ? { line: current.line } : {}),
    };
  }

  if (current.kind === 'array') {
    const idx = Number(seg);
    if (!Number.isInteger(idx) || idx < 0 || idx >= current.items.length) return null;
    const child = current.items[idx];
    if (child === undefined) return null;
    const replacedChild = replaceAt(child, segments, i + 1, newValue);
    if (replacedChild === null) return null;
    const newItems = current.items.slice();
    newItems[idx] = replacedChild;
    return {
      kind: 'array',
      items: newItems,
      ...(current.line !== undefined ? { line: current.line } : {}),
    };
  }

  // Primitive — can't descend.
  return null;
}

/**
 * Re-render `ast.raw` from the (possibly mutated) tree. We reuse the
 * render-mode emitter so callers can call `emitJsonc(ast)` after a set
 * and get the new bytes via the round-trip path. Tradeoff: post-edit,
 * comments and original formatting are lost — that's the cost of
 * edit-then-emit.
 */
function rebuildRaw(ast: JsoncAst): JsoncAst {
  const next: JsoncAst = { kind: 'jsonc', raw: '', root: ast.root };
  const rendered = emitJsonc(next, { mode: 'render' });
  return { ...ast, raw: rendered };
}
