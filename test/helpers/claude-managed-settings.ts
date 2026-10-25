import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

/** Keep synthetic Claude logins independent of the test host's managed policy. */
export function mockClaudeManagedSettings(directory: string) {
  const roots = [
    "/etc/claude-code",
    "/Library/Application Support/ClaudeCode",
    "C:/Program Files/ClaudeCode",
  ];
  const fixturePath = (target: fs.PathLike): string | undefined => {
    const normalized = String(target).replaceAll("\\", "/");
    const root = roots.find((dir) => normalized === dir || normalized.startsWith(`${dir}/`));
    return root ? path.join(directory, normalized.slice(root.length)) : undefined;
  };
  const { realpathSync, readdirSync } = fs;
  vi.spyOn(fs, "realpathSync").mockImplementation(((target: fs.PathLike, options?: never) =>
    realpathSync(fixturePath(target) ?? target, options)) as typeof fs.realpathSync);
  vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike, options?: never) =>
    readdirSync(fixturePath(target) ?? target, options)) as typeof fs.readdirSync);
  return fixturePath;
}
