import { assertDatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type { SessionColdSource } from "./session-cold-storage.types.js";
import {
  assertSessionStoreReadCandidate,
  isSessionStoreReadCandidateCurrent,
} from "./session-store-read-candidates.js";

// Preparation and mutation share physical custody without loading mutation owners into readers.
export function assertSessionColdSourceCurrent(pathname: string, source: SessionColdSource): void {
  for (const custody of source.readCustody ?? []) {
    assertSessionStoreReadCandidate(custody.sourcePath, custody.candidates);
    for (const candidate of custody.candidates) {
      if (!isSessionStoreReadCandidateCurrent(candidate)) {
        throw new Error("Cold transcript selection changed outside its original custody");
      }
      if (candidate.identity) {
        assertDatabasePathIdentity(candidate.path, candidate.identity);
      }
    }
  }
  assertDatabasePathIdentity(pathname, source.readIdentity);
}
