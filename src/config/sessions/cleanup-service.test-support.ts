import { vi } from "vitest";
import * as cleanupReads from "./cleanup-service-read.js";
import type { SessionCleanupReadResult } from "./cleanup-service-read.types.js";
import { appendTranscriptMessageSync } from "./session-accessor.js";

export const sessionScope = (storePath: string, name: string) => ({
  agentId: "main",
  storePath,
  sessionKey: `agent:main:${name}`,
  sessionId: name,
});
export function appendUserMessage(
  scope: Parameters<typeof appendTranscriptMessageSync>[0],
  eventId: string,
  text: string,
) {
  appendTranscriptMessageSync(scope, {
    eventId,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

export function afterCleanupRead(
  callback: (snapshot: SessionCleanupReadResult, fixMissing?: boolean) => void,
) {
  const readStore = cleanupReads.withSessionCleanupStore;
  return vi
    .spyOn(cleanupReads, "withSessionCleanupStore")
    .mockImplementation((target, consume, options) =>
      readStore(
        target,
        (owner) =>
          consume({
            ...owner,
            read: async (fixMissing) => {
              const snapshot = await owner.read(fixMissing);
              callback(snapshot, fixMissing);
              return snapshot;
            },
          }),
        options,
      ),
    );
}
