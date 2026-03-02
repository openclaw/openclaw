import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
  });
  await fs.promises.chmod(tmp, 0o600);
  await fs.promises.rename(tmp, filePath);
}
