import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";

const exec = promisify(execFile);
const gitOutput = async (argv: string[]) =>
  (await exec("git", argv, { encoding: "utf8" })).stdout.trim();
export const git = (cwd: string, ...args: string[]) => gitOutput(["-C", cwd, ...args]);
export const gitWithoutLocks = (cwd: string, ...args: string[]) =>
  gitOutput(["--no-optional-locks", "-C", cwd, ...args]);
export const readText = (...parts: string[]) => fs.readFile(path.join(...parts), "utf8");
export const writeFile = (
  directory: string,
  file: string,
  data: Parameters<typeof fs.writeFile>[1],
) => fs.writeFile(path.join(directory, file), data);

export async function expectMissing(operation: Promise<unknown>) {
  await expect(operation).rejects.toMatchObject({ code: "ENOENT" });
}

export async function expectFiles(directory: string, files: Record<string, string>) {
  for (const [file, contents] of Object.entries(files)) {
    expect(await readText(directory, file), file).toBe(contents);
  }
}
