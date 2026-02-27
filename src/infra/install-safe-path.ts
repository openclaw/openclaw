import { createHash } from "node:crypto";
import path from "node:path";

export function unscopedPackageName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.includes("/") ? (trimmed.split("/").pop() ?? trimmed) : trimmed;
}

export function safeDirName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.replaceAll("/", "__").replaceAll("\\", "__");
}

export function safePathSegmentHashed(input: string): string {
  const trimmed = input.trim();
  const base = trimmed
    .replaceAll(/[\\/]/g, "-")
    .replaceAll(/[^a-zA-Z0-9._-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-+/g, "")
    .replaceAll(/-+$/g, "");

  const normalized = base.length > 0 ? base : "skill";
  const safe = normalized === "." || normalized === ".." ? "skill" : normalized;

  const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 10);

  if (safe !== trimmed) {
    const prefix = safe.length > 50 ? safe.slice(0, 50) : safe;
    return `${prefix}-${hash}`;
  }
  if (safe.length > 60) {
    return `${safe.slice(0, 50)}-${hash}`;
  }
  return safe;
}

export function resolveSafeInstallDir(params: {
  baseDir: string;
  id: string;
  invalidNameMessage: string;
}): { ok: true; path: string } | { ok: false; error: string } {
  const targetDir = path.join(params.baseDir, safeDirName(params.id));
  const resolvedBase = path.resolve(params.baseDir);
  const resolvedTarget = path.resolve(targetDir);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return { ok: false, error: params.invalidNameMessage };
  }
  return { ok: true, path: targetDir };
}
