import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type { SessionTranscriptContextSnapshot } from "./session-history-read.types.js";

export type SessionTranscriptContextReader = <T>(
  target: SessionTranscriptRuntimeTarget,
  read: (messages: Iterable<AgentMessage>, header: unknown) => T,
) => Promise<T>;

/** The owner retains scanning, consumer work, validation, and cleanup together. */
export function createSessionTranscriptContextReader(owner: {
  assertCurrent(target: SessionTranscriptRuntimeTarget): void;
  read(): Promise<SessionTranscriptContextSnapshot>;
  validate(snapshot: SessionTranscriptContextSnapshot): Promise<void>;
  retain<T>(operation: () => Promise<T>): Promise<T>;
}): SessionTranscriptContextReader {
  return (target, read) =>
    owner.retain(async () => {
      owner.assertCurrent(target);
      const snapshot = await owner.read();
      owner.assertCurrent(target);
      const messages = (function* () {
        for (const message of snapshot.messages) {
          owner.assertCurrent(target);
          yield message;
        }
      })();
      try {
        const result = await read(messages, snapshot.header);
        await owner.validate(snapshot);
        owner.assertCurrent(target);
        return result;
      } finally {
        messages.return(undefined);
      }
    });
}
