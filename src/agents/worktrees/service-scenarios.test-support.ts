import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import type * as commandExec from "../../process/exec.js";

const execFileAsync = promisify(execFile);
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}
export const writeFile = (root: string, name: string, contents: string | Uint8Array) =>
  fs.writeFile(path.join(root, name), contents);

export async function expectFile(root: string, name: string, contents: string) {
  expect(await fs.readFile(path.join(root, name), "utf8")).toBe(contents);
}
export async function expectMissing(target: string) {
  await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
}
export function atGate<T>(
  gate: PromiseLike<T>,
  work: PromiseLike<unknown>,
  message: string,
  signal: AbortSignal,
) {
  return withinTest(awaitGateBeforeSettlement(gate, work, message), signal);
}
export function afterCommand(
  commands: Pick<typeof commandExec, "runCommandWithTimeout">,
  effect: (
    argv: Parameters<typeof commandExec.runCommandWithTimeout>[0],
    result: Awaited<ReturnType<typeof commandExec.runCommandWithTimeout>>,
  ) => Promise<void>,
) {
  const run = commands.runCommandWithTimeout;
  return vi.spyOn(commands, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
    const result = await run(argv, options);
    await effect(argv, result);
    return result;
  });
}
