import {
  readDatabasePathIdentitySync,
  type DatabaseFileIdentity,
} from "../../infra/sqlite-worker-identity.js";

export class TranscriptPageIdentityError extends Error {
  constructor(readonly reason: "missing" | "stale_session") {
    super(reason);
    this.name = "TranscriptPageIdentityError";
  }
}

/** File identity is a source fence, not proof of nonmutating SQLite admission. */
export function assertTranscriptPageIdentity(
  pathname: string | undefined,
  expected: DatabaseFileIdentity,
): void {
  if (!pathname) {
    throw new TranscriptPageIdentityError("missing");
  }
  const current = readDatabasePathIdentitySync(pathname);
  if (!current.key.startsWith("file:")) {
    throw new TranscriptPageIdentityError("missing");
  }
  if (
    current.key !== expected.key ||
    (expected.birthtime !== undefined && current.birthtime !== expected.birthtime)
  ) {
    throw new TranscriptPageIdentityError("stale_session");
  }
}
