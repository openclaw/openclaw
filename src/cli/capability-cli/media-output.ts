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

// Cap individual CLI input files at 100 MiB — media and document files
// passed via --file to openclaw capability commands.
const MAX_CLI_INPUT_FILE_BYTES = 100 * 1024 * 1024;
// Aggregate budget for a single --file invocation to prevent OOM when
// multiple permitted inputs are provided together.
const MAX_TOTAL_CLI_INPUT_FILE_BYTES = 500 * 1024 * 1024;

/** Read a user-supplied input file with a size pre-check to prevent OOM. */
async function readCliInputFileSafely(
  filePath: string,
  budget: { remaining: number },
): Promise<Buffer> {
  const resolvedPath = path.resolve(filePath);
  const handle = await fs.open(resolvedPath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`not a regular file: ${resolvedPath}`);
    }
    if (stat.size > MAX_CLI_INPUT_FILE_BYTES) {
      throw new Error(
        `file too large: ${resolvedPath} is ${stat.size} bytes (max ${MAX_CLI_INPUT_FILE_BYTES})`,
      );
    }
    if (stat.size > budget.remaining) {
      throw new Error(
        `file too large: ${resolvedPath} is ${stat.size} bytes (max remaining total budget ${budget.remaining})`,
      );
    }
    budget.remaining -= stat.size;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readInputFiles(
  files: string[],
): Promise<Array<{ path: string; buffer: Buffer }>> {
  // Process files sequentially with an aggregate byte budget so one command
  // invocation cannot allocate more than MAX_TOTAL_CLI_INPUT_FILE_BYTES.
  const budget = { remaining: MAX_TOTAL_CLI_INPUT_FILE_BYTES };
  const result: Array<{ path: string; buffer: Buffer }> = [];
  for (const filePath of files) {
    const resolvedPath = path.resolve(filePath);
    result.push({
      path: resolvedPath,
      buffer: await readCliInputFileSafely(resolvedPath, budget),
    });
  }
  return result;
}
