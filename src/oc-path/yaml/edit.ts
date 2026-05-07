/**
 * Mutate a `YamlAst` at an OcPath. Returns a new AST with the value
 * replaced.
 *
 * Implementation uses `doc.setIn(path, value)` from the `yaml` package
 * — comment-preserving on edit. Adding a new key does NOT preserve
 * surrounding formatting verbatim (the `yaml` library handles
 * pretty-printing); for byte-exact preservation use round-trip emit
 * on unmodified ASTs.
 *
 * @module @openclaw/oc-path/yaml/edit
 */

import { Document, LineCounter, parseDocument } from 'yaml';
import type { OcPath } from '../oc-path.js';
import type { YamlAst } from './ast.js';

export type YamlEditResult =
  | { readonly ok: true; readonly ast: YamlAst }
  | {
      readonly ok: false;
      readonly reason: 'unresolved' | 'no-root' | 'parse-error';
    };

export function setYamlOcPath(
  ast: YamlAst,
  path: OcPath,
  newValue: unknown,
): YamlEditResult {
  if (ast.doc.contents === null) return { ok: false, reason: 'no-root' };

  const segments = pathSegments(path);
  if (segments.length === 0) {
    return { ok: false, reason: 'unresolved' };
  }

  // Verify the path resolves before mutating — `setIn` would create
  // missing intermediate nodes which is insertion semantics, not set.
  if (!ast.doc.hasIn(segments)) {
    return { ok: false, reason: 'unresolved' };
  }

  // Clone the document so the original AST is unchanged.
  const { doc: cloned, lineCounter } = cloneDoc(ast.doc);
  cloned.setIn(segments, newValue);
  return { ok: true, ast: { kind: 'yaml', raw: cloned.toString(), doc: cloned, lineCounter } };
}

/**
 * Append-style insertion: add a new key to a map or push to a seq at
 * `path`. Used by the universal `setOcPath` when the path carries a
 * `+` / `+key` / `+nnn` insertion marker.
 */
export function insertYamlOcPath(
  ast: YamlAst,
  parentPath: OcPath,
  marker: '+' | { kind: 'keyed'; key: string } | { kind: 'indexed'; index: number },
  newValue: unknown,
): YamlEditResult {
  if (ast.doc.contents === null) return { ok: false, reason: 'no-root' };

  const segments = pathSegments(parentPath);
  const { doc: cloned, lineCounter } = cloneDoc(ast.doc);

  // Find the parent node.
  const parent = segments.length === 0 ? cloned.contents : cloned.getIn(segments, false);
  if (parent === undefined || parent === null) return { ok: false, reason: 'unresolved' };

  // Map insertion → keyed
  if (typeof parent === 'object' && 'items' in parent && Array.isArray((parent as { items: unknown[] }).items)) {
    const items = (parent as { items: { key?: unknown }[] }).items;
    const isMapLike = items.length === 0 || items.every((p) => 'key' in p);

    if (isMapLike) {
      if (typeof marker !== 'object' || marker.kind !== 'keyed') {
        return { ok: false, reason: 'unresolved' };
      }
      // Reject duplicate
      if (cloned.hasIn([...segments, marker.key])) {
        return { ok: false, reason: 'unresolved' };
      }
      cloned.setIn([...segments, marker.key], newValue);
      return { ok: true, ast: { kind: 'yaml', raw: cloned.toString(), doc: cloned, lineCounter } };
    }

    // Seq insertion
    if (typeof marker === 'object' && marker.kind === 'keyed') {
      return { ok: false, reason: 'unresolved' };
    }
    const seqItems = items as unknown[];
    if (marker === '+') {
      cloned.addIn(segments, newValue);
    } else if (typeof marker === 'object' && marker.kind === 'indexed') {
      const idx = Math.min(marker.index, seqItems.length);
      const current = cloned.getIn(segments) as unknown[] | undefined;
      if (!Array.isArray(current)) return { ok: false, reason: 'unresolved' };
      const newArr = [...current];
      newArr.splice(idx, 0, newValue);
      cloned.setIn(segments, newArr);
    }
    return { ok: true, ast: { kind: 'yaml', raw: cloned.toString(), doc: cloned, lineCounter } };
  }

  return { ok: false, reason: 'unresolved' };
}

function pathSegments(path: OcPath): string[] {
  const segs: string[] = [];
  if (path.section !== undefined) segs.push(...path.section.split('.'));
  if (path.item !== undefined) segs.push(...path.item.split('.'));
  if (path.field !== undefined) segs.push(...path.field.split('.'));
  return segs;
}

function cloneDoc(doc: Document.Parsed): { doc: Document.Parsed; lineCounter: LineCounter } {
  // Round-trip via toString → parseDocument is the simplest comment-
  // preserving clone. yaml package doesn't expose a public `clone`.
  // Re-parse with a fresh LineCounter so the cloned AST has accurate
  // line positions for any subsequent inspection.
  const lineCounter = new LineCounter();
  const cloned = parseDocument(doc.toString(), {
    keepSourceTokens: true,
    prettyErrors: false,
    lineCounter,
  });
  return { doc: cloned, lineCounter };
}
