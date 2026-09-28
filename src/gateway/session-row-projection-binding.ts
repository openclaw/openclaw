import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type EntryReader = (query: {
  agentId: string;
  key: string;
  storePath: string;
}) => SessionEntry | undefined;

// Source and built callers must recognize the same opaque context binding.
export const SessionRowProjectionBinding = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionRowProjectionBinding"),
  () =>
    class {
      readonly owner: object;
      readonly readCommittedEntry: EntryReader;

      constructor(owner: object, readCommittedEntry: EntryReader) {
        this.owner = owner;
        this.readCommittedEntry = readCommittedEntry;
      }
    },
);
