import { expectDefined } from "@openclaw/normalization-core/expect";
import { isPromptCacheRecoveryCandidate } from "../../sessions/prompt-cache-recovery.js";
import { captureMemoryExactSessionReader } from "./session-accessor.memory-exact-read.js";
import { captureSessionEntryReadScope } from "./session-entry-read-request.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import type { SessionStoreWorkerReadScope } from "./session-entry-read-runtime.types.js";

export async function readPromptCacheRecoveryKeysInWorker(
  input: Pick<SessionStoreWorkerReadScope, "agentId" | "storePath" | "env">,
  since: number,
): Promise<string[]> {
  const memory = captureMemoryExactSessionReader(input);
  if (memory) {
    return memory
      .entries("list")
      .filter(({ sessionKey, entry }) => isPromptCacheRecoveryCandidate(sessionKey, entry, since))
      .map(({ sessionKey }) => sessionKey);
  }
  const { scope } = captureSessionEntryReadScope({ ...input, sessionKey: "" });
  return withSessionStoreReaderInWorker(
    { ...input, env: scope.env, storePath: scope.storePath ?? input.storePath },
    async ({ reader, database, continuation, assertCurrent }) => {
      assertCurrent();
      const result = await reader.readEntries(
        {
          agentId: database.agentId,
          storePath: database.path,
          env: database.env,
          promptCacheSince: since,
        },
        continuation,
      );
      assertCurrent();
      return expectDefined(result.promptCacheKeys, "prompt-cache recovery keys");
    },
    { backing: true, dataOnly: true },
  );
}
