import fs from "node:fs";
import path from "node:path";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  return Math.max(1, Math.floor(fallback));
}

export function ensureDirForFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

export function writeJsonFileSecure(pathname: string, value: unknown): void {
  ensureDirForFile(pathname);
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
}

export function readTextFileIfExists(pathname: string): string | null {
  if (!fs.existsSync(pathname)) {
    return null;
  }
  return fs.readFileSync(pathname, "utf8");
}

export function writeTextFileAtomic(pathname: string, value: string, mode = 0o600): void {
  ensureDirForFile(pathname);
  const tempPath = `${pathname}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, value, "utf8");
  fs.chmodSync(tempPath, mode);
  fs.renameSync(tempPath, pathname);
}
