import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { chatMetadataSessionFields } from "../../gateway/server-methods/chat-metadata-contract.js";
import {
  sessionEntryReadRevision,
  sessionInitializationFingerprint,
} from "./session-entry-read-revision.js";
import type { IncognitoSessionFacts } from "./session-incognito-facts.types.js";
import type { SessionEntry } from "./types.js";

/** Derive each read contract's exact comparison from the same authoritative row. */
export function projectIncognitoSessionReadRevisions(
  entry: SessionEntry | undefined,
): Pick<
  IncognitoSessionFacts,
  "entryReadRevision" | "initializationFingerprint" | "chatMetadataRevision"
> {
  return {
    entryReadRevision: entry ? sessionEntryReadRevision(entry) : undefined,
    initializationFingerprint: entry ? sessionInitializationFingerprint(entry) : undefined,
    chatMetadataRevision: entry
      ? sha256Hex(JSON.stringify(chatMetadataSessionFields.map((field) => entry[field])))
      : undefined,
  };
}
