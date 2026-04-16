import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveCliName } from "./cli-name.js";
import { asNumber, asRecord, asString, resolveTempPathParts } from "./nodes-media-utils.js";

export type FileReadPayload = {
  path: string;
  encoding: "base64" | "utf8";
  data: string;
  size: number;
  mimeType?: string;
};

export type FileWriteResponse = {
  path: string;
  size: number;
  ok: true;
};

export function parseFileReadPayload(value: unknown): FileReadPayload {
  const obj = asRecord(value);
  const filePath = asString(obj.path);
  const encoding = asString(obj.encoding);
  const data = asString(obj.data);
  const size = asNumber(obj.size);
  const mimeType = asString(obj.mimeType);
  if (!filePath) {
    throw new Error("invalid file.read payload: missing path");
  }
  if (!data) {
    throw new Error(`invalid file.read payload: missing data for ${filePath}`);
  }
  if (encoding !== "base64" && encoding !== "utf8") {
    throw new Error(`invalid file.read payload: unsupported encoding "${encoding ?? "undefined"}"`);
  }
  if (size === undefined) {
    throw new Error(`invalid file.read payload: missing size for ${filePath}`);
  }
  return {
    path: filePath,
    encoding,
    data,
    size,
    ...(mimeType ? { mimeType } : {}),
  };
}

export function fileTempPath(opts: { remotePath: string; tmpDir?: string; id?: string }): string {
  const ext = path.extname(opts.remotePath) || ".bin";
  const {
    tmpDir,
    id,
    ext: normalizedExt,
  } = resolveTempPathParts({
    tmpDir: opts.tmpDir,
    id: opts.id,
    ext,
  });
  const cliName = resolveCliName();
  return path.join(tmpDir, `${cliName}-file-transfer-${id}${normalizedExt}`);
}

export async function writeFilePayloadToFile(
  filePath: string,
  payload: FileReadPayload,
): Promise<{ path: string; size: number }> {
  const buf =
    payload.encoding === "base64"
      ? Buffer.from(payload.data, "base64")
      : Buffer.from(payload.data, "utf8");
  await fs.writeFile(filePath, buf);
  return { path: filePath, size: buf.length };
}
