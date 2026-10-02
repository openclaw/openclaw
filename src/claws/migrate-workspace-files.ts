import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { ClawMigrationError } from "./migrate-errors.js";
import { lstatMigrationPathIfExists } from "./migrate-package.js";
import type { CapturedWorkspaceFile } from "./migrate-package.js";
import { containsPotentialSecret } from "./migrate-validation.js";
import { MAX_MANAGED_FILE_BYTES, MAX_MANAGED_WORKSPACE_BYTES } from "./source-limits.js";
import { CLAW_BOOTSTRAP_FILE_NAMES } from "./types.js";

const PROMPT_FILE_NAMES = [...CLAW_BOOTSTRAP_FILE_NAMES];

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function readSelectedWorkspaceFiles(
  workspace: string,
): Promise<CapturedWorkspaceFile[]> {
  const root = await fsSafeRoot(workspace, {
    hardlinks: "reject",
    maxBytes: MAX_MANAGED_FILE_BYTES,
    symlinks: "reject",
  });
  const captured: CapturedWorkspaceFile[] = [];
  let totalBytes = 0;
  for (const name of PROMPT_FILE_NAMES) {
    const info = await lstatMigrationPathIfExists(resolve(workspace, name));
    if (!info) {
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new ClawMigrationError(
        "workspace_file_unsafe",
        `${name} must be a regular, non-symlinked, non-hardlinked file.`,
        `$.workspace.${name}`,
      );
    }
    const read = await root.read(name, {
      hardlinks: "reject",
      maxBytes: MAX_MANAGED_FILE_BYTES,
      symlinks: "reject",
    });
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(read.buffer);
    } catch {
      throw new ClawMigrationError(
        "workspace_file_encoding_unsupported",
        `${name} is not valid UTF-8 text and cannot be represented as an agent prompt file.`,
        `$.workspace.${name}`,
      );
    }
    if (containsPotentialSecret(text)) {
      throw new ClawMigrationError(
        "workspace_file_secret_detected",
        `Potential secret material was found in ${name}. Remove it or leave this file unmanaged; the matching text was not displayed.`,
        `$.workspace.${name}`,
      );
    }
    totalBytes += read.buffer.byteLength;
    if (totalBytes > MAX_MANAGED_WORKSPACE_BYTES) {
      throw new ClawMigrationError(
        "workspace_files_too_large",
        `Selected prompt files exceed the ${MAX_MANAGED_WORKSPACE_BYTES}-byte Claw workspace limit.`,
        "$.workspace",
      );
    }
    captured.push({ name, content: read.buffer, digest: sha256(read.buffer) });
  }
  return captured;
}
