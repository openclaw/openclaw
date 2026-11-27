import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionAdmissionEntryIdentity = Readonly<
  Pick<SessionEntry, "sessionId" | "lifecycleRevision">
>;

/** Exact identity change committed by the host, independent of the admission executor. */
export type SessionAdmissionTransition = Readonly<{
  previous?: SessionAdmissionEntryIdentity;
  current: SessionAdmissionEntryIdentity;
}>;
