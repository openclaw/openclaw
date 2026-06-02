import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";

/** Returns whether a package entry path points at a TypeScript source module. */
export function isTypeScriptPackageEntry(entryPath: string): boolean {
  return [".ts", ".mts", ".cts"].includes(path.extname(entryPath).toLowerCase());
}

/** Lists built JS runtime entry candidates for a TypeScript package entry path. */
export function listBuiltRuntimeEntryCandidates(entryPath: string): string[] {
  if (!isTypeScriptPackageEntry(entryPath)) {
    return [];
  }
  const normalized = entryPath.replace(/\\/g, "/");
  const withoutExtension = normalized.replace(/\.[^.]+$/u, "");
  const normalizedRelative = normalized.replace(/^\.\//u, "");
  // `src/foo.ts` package entries build to `dist/foo.js`; non-src entries keep their
  // relative shape under dist so package metadata can use either layout.
  const distWithoutExtension = normalizedRelative.startsWith("src/")
    ? `./dist/${normalizedRelative.slice("src/".length).replace(/\.[^.]+$/u, "")}`
    : `./dist/${withoutExtension.replace(/^\.\//u, "")}`;
  const withJavaScriptExtensions = (basePath: string) => [
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
  ];
  const candidates = [
    ...withJavaScriptExtensions(distWithoutExtension),
    ...withJavaScriptExtensions(withoutExtension),
  ];
  // Keep dist-first ordering for runtime/package consumers while dropping duplicate source paths.
  return uniqueStrings(candidates).filter((candidate) => candidate !== normalized);
}
