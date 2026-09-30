import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isMissingPathError } from "./errno.js";
import { JsonFileReadError, readJsonIfExists } from "./json-files.js";

const log = createSubsystemLogger("install-owner");
const InstallOwnerSchema = z.object({
  schemaVersion: z.literal(1),
  owner: z.literal("macos-app"),
  displayName: z.string().trim().min(1),
  updateHint: z.string().trim().min(1),
});

export type InstallOwner = z.infer<typeof InstallOwnerSchema>;

/** Packaging owns this marker; absent or invalid files preserve normal install discovery. */
export async function readInstallOwner(root: string | null): Promise<InstallOwner | null> {
  if (!root) {
    return null;
  }
  const marker = path.join(root, "openclaw-install-owner.json");
  try {
    const value = await readJsonIfExists<unknown>(marker, { maxBytes: 16_384 });
    // JSON null is invalid; a missing optional marker must not enter read-retry timers.
    if (value === null) {
      await fs.access(marker);
    }
    const parsed = InstallOwnerSchema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }
  } catch (error) {
    if (
      isMissingPathError(error) ||
      (error instanceof JsonFileReadError && isMissingPathError(error.cause))
    ) {
      return null;
    }
    // A malformed or unreadable packaging marker must not prevent the CLI from starting.
  }
  log.warn(`Ignoring invalid install owner marker: ${marker}`);
  return null;
}

export function formatInstallOwnerMessage(owner: InstallOwner): string {
  return `Managed by ${owner.displayName}. ${owner.updateHint}`;
}
