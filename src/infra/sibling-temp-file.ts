// Exposes sibling temp file writes with fs-safe defaults.
import "./fs-safe-defaults.js";
// Atomic sibling temp writes preserve target-directory permissions and avoid
// cross-device rename behavior.
import {
  writeSiblingTempFile as writeSiblingTempFileBase,
  type WriteSiblingTempFileOptions,
} from "@openclaw/fs-safe/advanced";

export async function writeSiblingTempFile<T>(options: WriteSiblingTempFileOptions<T>) {
  return await writeSiblingTempFileBase({
    ...options,
    producerIsolation: "private-directory",
  });
}
