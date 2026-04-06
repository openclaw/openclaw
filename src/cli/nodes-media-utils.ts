import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export { asRecord } from "../shared/record-coerce.js";

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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
    ext: opts.ext.startsWith(".") ? opts.ext : `.${opts.ext}`,
  };
}
