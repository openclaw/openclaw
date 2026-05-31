import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { asFiniteNumber } from "../../packages/normalization-core/src/number-coercion.js";
import { asRecord as coerceRecord } from "../../packages/normalization-core/src/record-coerce.js";
import { readStringValue } from "../../packages/normalization-core/src/string-coerce.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { asBoolean as coerceBoolean } from "../utils/boolean.js";

/** Numeric coercion helper for node media payloads. */
export const asNumber = asFiniteNumber;

/** Record coercion helper for node media payloads. */
export const asRecord = coerceRecord;

/** Boolean coercion helper for node media payloads. */
export const asBoolean = coerceBoolean;

/** String coercion helper for node media payloads. */
export const asString = readStringValue;

/** Resolves a safe temp directory, id, and extension for node media outputs. */
export function resolveTempPathParts(opts: { ext: string; tmpDir?: string; id?: string }): {
  ext: string;
  tmpDir: string;
  id: string;
} {
  const tmpDir = opts.tmpDir ?? resolvePreferredOpenClawTmpDir();
  const rawExt = opts.ext.startsWith(".") ? opts.ext : `.${opts.ext}`;
  if (!/^\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/u.test(rawExt)) {
    // Extensions become path suffixes, so reject traversal, slashes, and oversized values.
    throw new Error("invalid media format");
  }
  if (!opts.tmpDir) {
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  }
  return {
    tmpDir,
    id: opts.id ?? randomUUID(),
    ext: rawExt,
  };
}
