import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isFileReference } from "../../../../packages/gateway-protocol/src/compiled/file-reference.js";
import type { FileReference } from "../../../../src/shared/file-references.js";
import { isComposerSpan, mapComposerSpans } from "./composer-spans.ts";

export type ComposerFileReference = {
  start: number;
  end: number;
  reference: FileReference;
};

/** Display-only escaping; the canonical path remains byte-for-byte provider data. */
export function fileReferenceText(reference: FileReference): string {
  return `@${reference.relativePath.replace(
    // oxlint-disable-next-line eslint/no-control-regex -- Inert labels must expose control and bidi characters.
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`,
  )}`;
}

/** Storage and editor import boundary: visible text cannot retarget an object. */
export function readComposerFileReferences(
  text: string,
  value: unknown,
): readonly ComposerFileReference[] | undefined {
  if (!Array.isArray(value) || value.length > 64) {
    return undefined;
  }
  const references: ComposerFileReference[] = [];
  let end = 0;
  for (const entry of value) {
    if (
      !isComposerSpan(entry, end, text.length) ||
      !isFileReference(entry.reference) ||
      text.slice(entry.start, entry.end) !== fileReferenceText(entry.reference)
    ) {
      return undefined;
    }
    references.push({ start: entry.start, end: entry.end, reference: entry.reference });
    end = entry.end;
  }
  return references;
}

let editorEdit: { text: string; references: readonly ComposerFileReference[] } | undefined;

/** Metadata accompanies the existing synchronous input event, never a later patch. */
export function withComposerFileReferenceEdit<T>(
  text: string,
  references: readonly ComposerFileReference[],
  run: () => T,
): T {
  const previous = editorEdit;
  editorEdit = { text, references };
  try {
    return run();
  } finally {
    editorEdit = previous;
  }
}

export function readComposerFileReferenceEdit(text: string) {
  return editorEdit?.text === text ? editorEdit.references : undefined;
}

export function updateComposerFileReferences(
  previous: string,
  next: string,
  references: readonly ComposerFileReference[] = [],
): readonly ComposerFileReference[] {
  const selected = readComposerFileReferenceEdit(next);
  if (selected) {
    return selected;
  }
  return !references.length || previous === next
    ? references
    : mapComposerSpans(previous, next, references);
}

/** A future identity schema must not be erased by a reader that cannot decode it. */
export function hasUnreadableFileReferences(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.fileReferences !== undefined &&
    (typeof value.text !== "string" ||
      readComposerFileReferences(value.text, value.fileReferences) === undefined)
  );
}
