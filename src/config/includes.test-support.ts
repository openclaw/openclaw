import path from "node:path";
import type { IncludeResolver } from "./includes.js";

export const ROOT_DIR = path.parse(process.cwd()).root;
const CONFIG_DIR = path.join(ROOT_DIR, "config");
export const CONFIG_FILE = path.join(CONFIG_DIR, "openclaw.json");

export function configPath(...parts: string[]) {
  return path.join(CONFIG_DIR, ...parts);
}

export function createMockResolver(files: Record<string, unknown>): IncludeResolver {
  return {
    readFile: (filePath) => {
      if (filePath in files) {
        return JSON.stringify(files[filePath]);
      }
      throw new Error(`ENOENT: no such file: ${filePath}`);
    },
    parseJson: JSON.parse,
  };
}
