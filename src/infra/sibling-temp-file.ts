// Atomic sibling temp writes preserve target-directory permissions and avoid
// cross-device rename behavior.
import {
  writeSiblingTempFile as writeSiblingTempFileBase,
  type WriteSiblingTempFileOptions,
} from "@openclaw/fs-safe/advanced";
import { allowDrvfsRenameRecovery } from "./fs-safe-drvfs.js";

export async function writeSiblingTempFile<T>(options: WriteSiblingTempFileOptions<T>) {
  return await writeSiblingTempFileBase({
    ...options,
    producerIsolation: "private-directory",
    allowDrvfsRenameRecovery:
      options.allowDrvfsRenameRecovery !== false && allowDrvfsRenameRecovery(options.dir),
  });
}
