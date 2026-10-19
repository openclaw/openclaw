import fs from "node:fs/promises";
import { expect } from "vitest";

export async function expectMissingPath(targetPath: string): Promise<void> {
  let statError: NodeJS.ErrnoException | undefined;
  try {
    await fs.stat(targetPath);
  } catch (error) {
    statError = error as NodeJS.ErrnoException;
  }
  expect(statError).toBeInstanceOf(Error);
  expect(statError?.code).toBe("ENOENT");
  expect(statError?.path).toBe(targetPath);
  expect(statError?.syscall).toBe("stat");
}
