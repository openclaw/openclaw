import type { SessionFilesDisplay } from "../../../app/settings-contract.ts";
import { resolveAttachmentFileIcon } from "./chat-attachment-file-icon.ts";
import type { WorkspaceCatalogFile } from "./chat-session-workspace-catalog.ts";
import type { TranscriptAttachmentEntry } from "./chat-sidebar-content-types.ts";

/** One Session files row or tile: a session-written file/artifact or a transcript attachment. */
export type SessionFileEntry =
  | { kind: "file"; key: string; file: WorkspaceCatalogFile }
  | { kind: "attachment"; key: string; entry: TranscriptAttachmentEntry };

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function entryName(entry: SessionFileEntry): string {
  return entry.kind === "file" ? entry.file.name : entry.entry.label;
}

/** The icon family (image, pdf, archive, …) is the type a user recognizes at a glance. */
function entryTypeKey(entry: SessionFileEntry): string {
  if (entry.kind === "attachment" && entry.entry.kind === "image") {
    // Transcript images are images even when the message omitted a mime type or extension.
    return "image";
  }
  const mimeType = entry.kind === "file" ? entry.file.mimeType : entry.entry.mimeType;
  return resolveAttachmentFileIcon(entryName(entry), mimeType).family;
}

/** Files date by their last modification, attachments by their message; artifacts carry neither. */
function entryTime(entry: SessionFileEntry): number | undefined {
  return entry.kind === "file" ? entry.file.updatedAtMs : entry.entry.timestamp;
}

/**
 * Default keeps the catalog order (session files as the Gateway lists them, then
 * transcript attachments in order of appearance). Date puts the most recently
 * modified or sent entries first and leaves undated entries after them in default
 * order. Name and type sorts are stable.
 */
export function orderSessionFiles(
  files: readonly WorkspaceCatalogFile[],
  attachments: readonly TranscriptAttachmentEntry[],
  sort: SessionFilesDisplay["sort"],
): SessionFileEntry[] {
  const entries: SessionFileEntry[] = [
    ...files.map((file): SessionFileEntry => ({ kind: "file", key: file.key, file })),
    ...attachments.map((entry): SessionFileEntry => ({
      kind: "attachment",
      key: entry.key,
      entry,
    })),
  ];
  switch (sort) {
    case "date":
      return entries.toSorted(
        (left, right) =>
          (entryTime(right) ?? Number.NEGATIVE_INFINITY) -
          (entryTime(left) ?? Number.NEGATIVE_INFINITY),
      );
    case "name":
      return entries.toSorted((left, right) =>
        nameCollator.compare(entryName(left), entryName(right)),
      );
    case "type":
      return entries.toSorted(
        (left, right) =>
          entryTypeKey(left).localeCompare(entryTypeKey(right)) ||
          nameCollator.compare(entryName(left), entryName(right)),
      );
    default:
      return entries;
  }
}
