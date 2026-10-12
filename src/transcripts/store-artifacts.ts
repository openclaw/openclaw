import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { tempFile } from "@openclaw/fs-safe/advanced";
import { root } from "@openclaw/fs-safe/root";
import { sha256Hex } from "../infra/crypto-digest.js";
import { hasErrnoCode } from "../infra/errno.js";
import { removePathWithinRoot } from "../infra/fs-safe-remove.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";

export const TRANSCRIPT_PATH_SEGMENT_MAX_BYTES = 255;

export const TRANSCRIPT_EXPORT_FILE_NAMES = new Set([
  "metadata.json",
  "summary.json",
  "summary.md",
  "transcript.jsonl",
]);

export function safeTranscriptPathSegment(value: string): string {
  let segment = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!segment) {
    return "session";
  }
  if (segment.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)) {
    segment = Buffer.from(segment, "utf8")
      .toString("hex")
      .match(/.{2}/gu)!
      .map((byte) => `%${byte.toUpperCase()}`)
      .join("");
  }
  // Portable encoding is ASCII and can expand the slug. Bound the final bytes,
  // hashing the complete raw ID to distinguish IDs with discarded suffixes.
  if (segment.length > TRANSCRIPT_PATH_SEGMENT_MAX_BYTES) {
    const suffix = `-${sha256Hex(value)}`;
    return `${segment.slice(0, TRANSCRIPT_PATH_SEGMENT_MAX_BYTES - suffix.length)}${suffix}`;
  }
  return segment;
}

function legacyTranscriptPathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function dateSegment(value: string | undefined): string {
  const isoDate = value?.match(/^(\d{4}-\d{2}-\d{2})T/)?.[1];
  return isoDate ?? new Date().toISOString().slice(0, 10);
}

export function transcriptSessionSelector(
  session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">,
): string {
  return `${dateSegment(session.startedAt)}/${safeTranscriptPathSegment(session.sessionId)}`;
}

export function legacyTranscriptSessionSelector(
  session: TranscriptSessionDescriptor,
): string | undefined {
  const date = dateSegment(session.startedAt);
  const segment = legacyTranscriptPathSegment(session.sessionId);
  // An oversized component could never hold legacy files; probing it would
  // reject otherwise valid captures with ENAMETOOLONG before persistence.
  if (segment.length > TRANSCRIPT_PATH_SEGMENT_MAX_BYTES) {
    return undefined;
  }
  // The shipped sanitizer allowed dot components: `.` collapsed to the date
  // directory and `..` collapsed to the transcript root.
  if (segment === ".") {
    return date;
  }
  if (segment === "..") {
    return ".";
  }
  return `${date}/${segment}`;
}

export function transcriptSessionExportKey(
  session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">,
): string {
  return transcriptSessionSelector(session).toLowerCase();
}

export function normalizeExportText(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export async function writeTranscriptArtifact(
  rootDir: string,
  fileName: string,
  content: string,
  assertBeforeMutation?: () => void,
): Promise<string> {
  await writeTranscriptArtifactFile({
    rootDir,
    fileName,
    write: (filePath) => fs.writeFile(filePath, content, { mode: 0o600 }),
    assertBeforeMutation,
  });
  return sha256Hex(content);
}

/** Retain private staging and the destination root until guarded, durable publication. */
export async function writeTranscriptArtifactFile(params: {
  rootDir: string;
  fileName: string;
  write: (filePath: string) => Promise<void>;
  assertBeforeMutation?: () => void;
  signal?: AbortSignal;
}): Promise<void> {
  const target = await root(params.rootDir);
  // Match the former output owner's staging contract for roots under shared ancestors.
  const stage = await tempFile({
    rootDir: params.rootDir,
    prefix: "openclaw-transcript",
    fileName: params.fileName,
    onCleanupError(error) {
      throw error;
    },
  });
  try {
    const source = await root(stage.dir);
    await params.write(stage.path);
    // copyIn retains the former best-effort file/parent fsync behavior on every platform.
    await target.copyIn(
      params.fileName,
      { root: source, relativePath: path.basename(stage.path) },
      {
        mode: 0o600,
        durable: true,
        maxBytes: Infinity,
        sourceHardlinks: "reject",
        signal: params.signal,
        assertBeforeMutation: params.assertBeforeMutation,
      },
    );
  } finally {
    await stage.cleanup();
  }
}

export async function removeTranscriptArtifact(
  rootDir: string,
  fileName: string,
  assertBeforeMutation?: () => void,
): Promise<void> {
  await removePathWithinRoot({
    rootDir,
    relativePath: fileName,
    force: true,
    assertBeforeMutation,
  });
}

export async function isCaseSensitiveDirectory(directory: string): Promise<boolean> {
  const probeName = `.openclaw-case-probe-${randomUUID().toLowerCase()}`;
  const probePath = path.join(directory, probeName);
  const alternatePath = path.join(directory, probeName.toUpperCase());
  const handle = await fs.open(probePath, "wx", 0o600);
  await handle.close();
  try {
    try {
      await fs.access(alternatePath);
      return false;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return true;
      }
      throw error;
    }
  } finally {
    await fs.rm(probePath, { force: true });
  }
}
