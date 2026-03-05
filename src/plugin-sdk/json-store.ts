import fs from "node:fs";
import { writeJsonAtomic } from "../infra/json-files.js";
import { safeParseJson } from "../utils.js";

export async function readJsonFileWithFallback<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = safeParseJson<T>(raw);
    if (parsed == null) {
      return { value: fallback, exists: true };
    }
    return { value: parsed, exists: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { value: fallback, exists: false };
    }
    return { value: fallback, exists: false };
  }
}

export async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  await writeJsonAtomic(filePath, value, {
    mode: 0o600,
    trailingNewline: true,
    ensureDirMode: 0o700,
  });
}
