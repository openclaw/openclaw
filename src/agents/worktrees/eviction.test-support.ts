import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { requireGit } from "./git.js";

export const read = (directory: string, file: string) =>
  fs.readFile(path.join(directory, file), "utf8");
export const write = (directory: string, file: string, contents: string) =>
  fs.writeFile(path.join(directory, file), contents);
export const linkDirectory = (target: string, link: string) =>
  fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
export const gitDirectory = async (checkout: string) =>
  fs.realpath(await requireGit(checkout, ["rev-parse", "--absolute-git-dir"]));
export const gitCommonDirectory = async (checkout: string) =>
  fs.realpath(
    path.resolve(checkout, await requireGit(checkout, ["rev-parse", "--git-common-dir"])),
  );
const metadataBytes = (directory: string) =>
  Promise.all(["HEAD", "index"].map((file) => fs.readFile(path.join(directory, file))));

export async function relocatePrivateGitDirectory(
  checkout: string,
  directory: string,
  preserveLink = true,
) {
  const original = await gitDirectory(checkout);
  const common = await gitCommonDirectory(checkout);
  await fs.rename(original, directory);
  await write(directory, "commondir", `${common}\n`);
  await write(checkout, ".git", `gitdir: ${directory}\n`);
  if (preserveLink) {
    await linkDirectory(directory, original);
  }
  return { directory, commonDirectory: common, bytes: await metadataBytes(directory) };
}

export async function expectPrivateMetadata(
  storage: Awaited<ReturnType<typeof relocatePrivateGitDirectory>>,
) {
  expect(await metadataBytes(storage.directory)).toEqual(storage.bytes);
}
