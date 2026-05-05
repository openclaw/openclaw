import { tryReadJsonSync, tryReadJson, writeJsonSync } from "@openclaw/fs-safe/json";

export { tryReadJson, tryReadJsonSync, writeJsonSync };
export const readJsonFile = tryReadJson;
export const saveJsonFile = writeJsonSync;

export function loadJsonFile<T = unknown>(pathname: string): T | undefined {
  return tryReadJsonSync<T>(pathname) ?? undefined;
}
