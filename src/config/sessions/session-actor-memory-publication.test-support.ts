import { vi } from "vitest";
import * as publication from "./session-actor-memory-publication.js";

export function failSessionActorMemoryPublication(sessionKey: string): () => void {
  const publish = publication.publishSessionActorMemoryChanges;
  const spy = vi
    .spyOn(publication, "publishSessionActorMemoryChanges")
    .mockImplementation((owner, changes) => {
      publish(owner, changes);
      if (changes.some((change) => change.sessionKey === sessionKey)) {
        throw new Error("Memory publication failed after commit");
      }
    });
  return () => spy.mockRestore();
}
