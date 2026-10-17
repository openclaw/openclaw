import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";

export function workspaceFiles(root: string) {
  return {
    async expect(relative: string, expected: string | Buffer) {
      const file = path.join(root, relative);
      if (typeof expected === "string") {
        await expect(fs.readFile(file, "utf8")).resolves.toBe(expected);
      } else {
        await expect(fs.readFile(file)).resolves.toEqual(expected);
      }
    },
    async missing(relative: string) {
      await expect(fs.stat(path.join(root, relative))).rejects.toMatchObject({ code: "ENOENT" });
    },
  };
}
