import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { readStringValue } from "../shared/string-coerce.js";
export { asRecord } from "../shared/record-coerce.js";

export const asString = readStringValue;

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeTempFileExtension(ext: string): string {
  const trimmed = ext.trim();
  if (!trimmed) {
    throw new Error("invalid temp file extension");
  }
  const normalized = trimmed.startsWith(".") ? trimmed.slice(1) : trimmed;
  if (!/^[a-z0-9][a-z0-9._+-]{0,31}$/i.test(normalized)) {
    throw new Error(`invalid temp file extension: ${ext}`);
  }
  return `.${normalized}`;
}

export function resolveTempPathParts(opts: { ext: string; tmpDir?: string; id?: string }): {
  ext: string;
  tmpDir: string;
  id: string;
} {
  const tmpDir = opts.tmpDir ?? resolvePreferredOpenClawTmpDir();
  if (!opts.tmpDir) {
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  }
  return {
    tmpDir,
    id: opts.id ?? randomUUID(),
    ext: normalizeTempFileExtension(opts.ext),
  };
}
