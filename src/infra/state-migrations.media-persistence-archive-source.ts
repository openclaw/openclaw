import path from "node:path";
import { readRegularFileSync } from "@openclaw/fs-safe/advanced";
import { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import { SESSION_ARCHIVE_ZSTD_SUFFIX } from "../config/sessions/archive-compression.js";
import { transformMediaArchiveContent } from "./state-migrations.media-persistence-transform.js";
import { encodeArchiveContent } from "./state-migrations.transcript-directives-archives.js";
import { decodeUtf8Input } from "./utf8-input.js";
import { resolveZstdCodec } from "./zstd-codec.js";

const ARCHIVE_TEMP_MARKER = ".media-retirement";

function archiveSourceMatches(
  filePath: string,
  expected: ReturnType<typeof readRegularFileSync>,
): boolean {
  try {
    const current = readRegularFileSync({ filePath });
    return (
      current.exactIdentity.dev === expected.exactIdentity.dev &&
      current.exactIdentity.ino === expected.exactIdentity.ino &&
      current.stat.mtimeMs === expected.stat.mtimeMs &&
      current.stat.size === expected.stat.size &&
      current.buffer.equals(expected.buffer)
    );
  } catch {
    return false;
  }
}

export function migrateTranscriptArchive(filePath: string): boolean {
  const source = readRegularFileSync({ filePath });
  const compressed = filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX);
  const content = decodeUtf8Input(
    compressed ? resolveZstdCodec().decompress(source.buffer) : source.buffer,
    filePath,
  );
  const transformed = transformMediaArchiveContent(content, filePath);
  if (!transformed.changed) {
    return false;
  }
  const codec = compressed ? "zstd" : "identity";
  const encoded = encodeArchiveContent(transformed.content, codec, filePath);
  replaceFileAtomicSync({
    filePath,
    content: encoded,
    preserveExistingMode: true,
    syncParentDir: true,
    syncTempFile: true,
    tempPrefix: `${path.basename(filePath)}${ARCHIVE_TEMP_MARKER}`,
    beforeRename: () => {
      if (!archiveSourceMatches(filePath, source)) {
        throw new Error(`${filePath} changed before atomic media migration replacement`);
      }
    },
  });
  return true;
}
