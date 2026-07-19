import fs from "node:fs/promises";
import path from "node:path";
import { detectMime, extensionForMime, normalizeMimeType } from "@openclaw/media-core/mime";
import { saveMediaBuffer } from "../../media/store.js";

export async function writeOutputAsset(params: {
  buffer: Buffer;
  mimeType?: string;
  originalFilename?: string;
  outputPath?: string;
  outputIndex: number;
  outputCount: number;
  subdir: string;
}) {
  if (!params.outputPath) {
    const saved = await saveMediaBuffer(
      params.buffer,
      params.mimeType,
      params.subdir,
      Number.MAX_SAFE_INTEGER,
      params.originalFilename,
    );
    return { path: saved.path, mimeType: saved.contentType, size: saved.size };
  }

  const resolvedOutput = path.resolve(params.outputPath);
  const parsed = path.parse(resolvedOutput);
  const detectedMime =
    (await detectMime({
      buffer: params.buffer,
      headerMime: params.mimeType,
    })) ?? params.mimeType;
  const requestedMime = normalizeMimeType(await detectMime({ filePath: resolvedOutput }));
  const detectedNormalized = normalizeMimeType(detectedMime);
  const canonicalDetectedExt = extensionForMime(detectedNormalized);
  const fallbackExt = parsed.ext || path.extname(params.originalFilename ?? "") || "";
  const ext =
    parsed.ext && requestedMime === detectedNormalized
      ? parsed.ext
      : (canonicalDetectedExt ?? fallbackExt);
  const filePath =
    params.outputCount <= 1
      ? path.join(parsed.dir, `${parsed.name}${ext}`)
      : path.join(parsed.dir, `${parsed.name}-${String(params.outputIndex + 1)}${ext}`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, params.buffer);
  return {
    path: filePath,
    mimeType: detectedNormalized ?? params.mimeType,
    size: params.buffer.byteLength,
  };
}

/**
 * Read a user-supplied input file through an open descriptor, binding the
 * read to the size observed at open time. This closes the race where a file
 * is substituted or grown between validation and consumption while preserving
 * the existing unlimited-input contract.
 */
async function readCliInputFileSafely(filePath: string): Promise<Buffer> {
  const resolvedPath = path.resolve(filePath);
  const handle = await fs.open(resolvedPath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`not a regular file: ${resolvedPath}`);
    }
    const size = stat.size;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) {
        // File shrank after stat; return the bytes we actually read.
        return buffer.subarray(0, offset);
      }
      offset += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

export async function readInputFiles(
  files: string[],
): Promise<Array<{ path: string; buffer: Buffer }>> {
  const result: Array<{ path: string; buffer: Buffer }> = [];
  for (const filePath of files) {
    const resolvedPath = path.resolve(filePath);
    result.push({
      path: resolvedPath,
      buffer: await readCliInputFileSafely(resolvedPath),
    });
  }
  return result;
}
