import type { PreparedQuestionCallerRead } from "../../agents/harness/host-private-capabilities.js";
import { createMemorySessionCapabilityStore } from "../../agents/subagents/spawn/subagent-session-store.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../../config/sessions/session-actor-storage-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";

/** Pin one memory namespace for both classification and capability policy. */
export function captureMemoryReplyToolAuthoritySession(
  sessionKey: string | undefined,
  assertCurrent: () => void,
) {
  if (!sessionKey) {
    return undefined;
  }
  const memory = captureSessionActorStorageOwner(
    { sessionKey },
    { assertCurrent, authorize: assertCurrent },
  );
  if (!memory) {
    return undefined;
  }
  return {
    capabilities: createMemorySessionCapabilityStore(memory),
    readEntry: () => {
      memory.authority.assertCurrent();
      memory.owner?.assertCurrent();
      memory.binding?.actor.assertReadable();
      return readCapturedSessionActorEntry(memory, sessionKey);
    },
  };
}

/** The final tool check consumes current actor policy; no native reader is retained. */
export function prepareMemoryReplyToolAuthorityCaller(
  readEntry: () => SessionEntry | undefined,
  assertActive: () => void,
  accepts: (entry: SessionEntry | undefined) => boolean,
): PreparedQuestionCallerRead {
  const assertCurrent = () => {
    assertActive();
    if (!accepts(readEntry())) {
      throw new Error("question answer caller policy does not match its creator");
    }
  };
  return {
    reads: [],
    assertPrepared: assertCurrent,
    prepareCurrent: async () => assertCurrent(),
    retainCurrent: () => ({ assertCurrent, release() {} }),
  };
}
