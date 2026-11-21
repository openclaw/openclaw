import { writeTextAtomic as writeFsSafeTextAtomic } from "@openclaw/fs-safe/atomic";
import { tryReadJsonSync } from "@openclaw/fs-safe/json";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

export {
  JsonFileReadError,
  readJson,
  readJsonIfExists,
  readJsonIfExists as readDurableJsonFile, // Sanctioned domain alias.
  readJsonSync,
  readRootJsonObjectSync,
  tryReadJson,
  tryReadJson as readJsonFile, // Sanctioned domain alias.
  tryReadJsonSync,
  writeJson,
  writeJson as writeJsonAtomic, // Sanctioned domain alias.
  writeJsonSync,
} from "@openclaw/fs-safe/json";

export { createAsyncLock } from "@openclaw/fs-safe/advanced";

export function tryReadJsonObjectSync(filePath: string): Record<string, unknown> | null {
  return asNullableRecord(tryReadJsonSync(filePath));
}

export const writeTextAtomic: typeof writeFsSafeTextAtomic = async (filePath, content, options) => {
  // The public SDK treats empty prefixes as defaults and ignores unrelated options.
  await writeFsSafeTextAtomic(filePath, content, {
    mode: options?.mode,
    dirMode: options?.dirMode,
    trailingNewline: options?.trailingNewline,
    durable: options?.durable,
    beforeRename: options?.beforeRename || undefined,
    tempPrefix: options?.tempPrefix || undefined,
  });
};
