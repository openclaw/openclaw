import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { attachSessionEntrySnapshots } from "./session-entry-snapshots.js";
import type { SessionEntry } from "./types.js";

/** Read acknowledgments and cold snapshots do not change retained list metadata. */
export function sessionEntryReadRevision(entry: SessionEntry): string {
  const metadata = attachSessionEntrySnapshots({ ...entry }, {}, "list");
  return sha256Hex(JSON.stringify({ ...metadata, lastReadAt: undefined }));
}

/** Initialization guards require complete row equality, including cold snapshot fields. */
export function sessionInitializationFingerprint(entry: SessionEntry): string | undefined {
  return entry.initializationPending === true ? sha256Hex(stableStringify(entry)) : undefined;
}
