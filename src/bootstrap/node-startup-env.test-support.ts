import type fs from "node:fs";

export function allowOnly(path: string) {
  return (candidate: Parameters<typeof fs.accessSync>[0]) => {
    if (candidate !== path) {
      throw new Error("ENOENT");
    }
  };
}
