import path from "node:path";

export function cronStoreKey(storePath: string): string {
  return path.resolve(storePath);
}
