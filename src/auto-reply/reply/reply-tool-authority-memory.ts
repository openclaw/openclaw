import type { PreparedQuestionCallerRead } from "../../agents/harness/host-private-capabilities.js";
import type { SessionEntry } from "../../config/sessions/types.js";

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
    retainNative: () => ({ assertCurrent, release() {} }),
  };
}
