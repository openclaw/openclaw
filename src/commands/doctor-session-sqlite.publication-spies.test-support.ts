import fs from "node:fs";
import { expect } from "vitest";
import type { SessionSqliteMigrationManifest } from "./doctor-session-sqlite.test-support.js";

export function contains(actual: unknown, ...items: unknown[]) {
  expect(actual).toEqual(expect.arrayContaining(items));
}

export function containsObjects(actual: unknown, ...items: Record<string, unknown>[]) {
  contains(actual, ...items.map((item) => expect.objectContaining(item)));
}

export function snapshotFiles(files: string[]) {
  return files.map((file) => ({ file, bytes: fs.readFileSync(file) }));
}

export function expectMissing(...files: string[]) {
  for (const file of files) {
    expect(fs.existsSync(file)).toBe(false);
  }
}

export function expectFiles(bytes: Buffer | string, ...files: string[]) {
  for (const file of files) {
    expect(
      typeof bytes === "string" ? fs.readFileSync(file, "utf8") : fs.readFileSync(file),
    ).toEqual(bytes);
  }
}

export function expectOriginal(file: string, bytes: Buffer, ino: bigint) {
  expectFiles(bytes, file);
  expect(fs.statSync(file, { bigint: true }).ino).toBe(ino);
}

export function writeManifest(file: string, manifest: SessionSqliteMigrationManifest) {
  fs.writeFileSync(file, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
}
