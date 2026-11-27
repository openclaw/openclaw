import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
import { nativeWorktreeFilesystem } from "./filesystem-native.js";

export const apfsFilesystem = {
  async readDirectoryAcl(
    this: void,
    directory: string,
    options: WorktreeFilesystemOptions,
  ): Promise<"none" | "non-inheritable" | "inheritable" | undefined> {
    const acl = await nativeWorktreeFilesystem.readAcl(directory, options);
    return acl.kind === "unknown"
      ? undefined
      : acl.kind === "none"
        ? "none"
        : acl.inheritsToFiles || acl.inheritsToDirectories
          ? "inheritable"
          : "non-inheritable";
  },
};
