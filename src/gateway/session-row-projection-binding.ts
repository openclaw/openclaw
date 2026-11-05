import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type EntryReader = (
  query: {
    agentId: string;
    storePath: string;
  } & ({ key: string; sessionId?: never } | { sessionId: string; key?: never }),
) => { entry: SessionEntry | undefined } | undefined;

// Source and built callers must recognize the same opaque context binding.
export const SessionRowProjectionBinding = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionRowProjectionBinding"),
  () =>
    class {
      constructor(
        readonly owner: object,
        readonly readCommittedEntry: EntryReader,
      ) {}
    },
);
