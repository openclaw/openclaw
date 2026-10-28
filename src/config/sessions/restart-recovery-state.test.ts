import { expect, it } from "vitest";
import {
  buildRestartRecoveryClaimCleanupPatch,
  normalizeRestartRecoveryEntryFields,
} from "./restart-recovery-state.js";
import type { SessionEntry } from "./types.js";

it.each([null, "webchat", undefined])(
  "retains source message channel %s until the recovery claim is cleared",
  (messageChannel) => {
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      restartRecoverySourceIngress: "internal",
      restartRecoverySourceMessageChannel: messageChannel,
    };
    normalizeRestartRecoveryEntryFields(entry, (key, value) => {
      entry[key] = value;
    });
    expect(entry.restartRecoverySourceMessageChannel).toBe(messageChannel);
    Object.assign(
      entry,
      buildRestartRecoveryClaimCleanupPatch({ entry, recordTerminalSource: false }),
    );
    expect(entry.restartRecoverySourceMessageChannel).toBeUndefined();
  },
);
