import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const fileHash = async (file: string) => sha256(await fs.readFile(file));

export async function json<T>(
  url: string,
  signal?: AbortSignal,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, { ...options, signal });
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

/** Bind a compiled plugin's declared entry and source bytes to the candidate proof. */
export async function pluginIdentity(repoRoot: string, plugin: string) {
  const root = path.join(await fs.realpath(repoRoot), "dist/extensions", plugin);
  const packageBytes = await fs.readFile(path.join(root, "package.json"));
  const pkg = JSON.parse(packageBytes.toString("utf8")) as {
    name: string;
    openclaw: { extensions: string[] };
  };
  expect(pkg.name).toBe(`@openclaw/${plugin}`);
  expect(pkg.openclaw.extensions).toEqual([expect.stringMatching(/^\.\/index\.(?:c|m)?js$/u)]);
  const entry = await fs.realpath(path.resolve(root, pkg.openclaw.extensions[0]!));
  expect(path.dirname(entry)).toBe(root);
  return {
    entry,
    packageSha256: sha256(packageBytes),
    entrySha256: await fileHash(entry),
    sourceSha256: await fileHash(path.join(repoRoot, "extensions", plugin, "index.ts")),
  };
}
