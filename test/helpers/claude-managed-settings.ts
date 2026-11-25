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
  vi.spyOn(fs, "readdirSync").mockImplementation(((
    target: fs.PathLike,
    options?:
      | BufferEncoding
      | "buffer"
      | null
      | {
          encoding?: BufferEncoding | "buffer" | null;
          withFileTypes?: boolean;
          recursive?: boolean;
        },
  ) => {
    const directoryPath = fixturePath(target) ?? target;
    const settings =
      typeof options === "string" ? { encoding: options, withFileTypes: false } : options;
    const encoding = settings?.encoding;
    // Preserve encoding and entry types while enforcing nonrecursive reads in the shared spy.
    if (settings?.withFileTypes) {
      return encoding === "buffer"
        ? readdirSync(directoryPath, { encoding: "buffer", withFileTypes: true, recursive: false })
        : readdirSync(directoryPath, { encoding, withFileTypes: true, recursive: false });
    }
    return encoding === "buffer"
      ? readdirSync(directoryPath, { encoding: "buffer", recursive: false })
      : readdirSync(directoryPath, { encoding, recursive: false });
  }) as typeof fs.readdirSync);
  return fixturePath;
}
