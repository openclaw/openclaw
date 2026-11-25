import fs from "node:fs/promises";
import path from "node:path";
import { statIfExists } from "../infra/path-existence.js";
import { writeSiblingTempFile } from "../infra/sibling-temp-file.js";

const DEFAULT_CLI_OUTPUT_TEMP_PREFIX = ".openclaw-media-output";

/** Publish a CLI-owned file only after its sibling temp write completes. */
export async function publishOutputFileAtomically<T>(params: {
  filePath: string;
  writeTemp: (tempPath: string) => Promise<T>;
  tempPrefix?: string;
  durable?: boolean;
}): Promise<T> {
  const dir = path.dirname(params.filePath);
  await fs.mkdir(dir, { recursive: true });
  const stat = await statIfExists(params.filePath);
  const mode = stat === undefined ? undefined : stat.mode & 0o7777;
  // Keep prior destination bytes and the existing directory mode untouched until completion.
  const { result } = await writeSiblingTempFile({
    dir,
    chmodDir: false,
    tempPrefix: params.tempPrefix ?? DEFAULT_CLI_OUTPUT_TEMP_PREFIX,
    ...(mode === undefined ? {} : { mode }),
    ...(params.durable ? { syncTempFile: true, syncParentDir: true } : {}),
    writeTemp: params.writeTemp,
    resolveFinalPath: () => params.filePath,
  });
  return result;
}
