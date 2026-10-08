import fs from "node:fs/promises";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { resetClientVoiceConfirmationStateForTest } from "./client-voice-confirmation.test-support.js";
import { prepareClientVoiceSessionClose } from "./client-voice-session-lifecycle.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

const { sendDurableMessageBatch } = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(async () => ({ status: "sent" })),
}));

vi.mock("../channels/message/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/message/runtime.js")>();
  return { ...actual, sendDurableMessageBatchCore: sendDurableMessageBatch };
});

export function useClientVoiceDigestHarness() {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir: string;
  const tempDirs = useAutoCleanupTempDirTracker((remove) => {
    afterEach(async () => {
      clientVoiceSessionTesting.reset();
      resetClientVoiceConfirmationStateForTest();
      try {
        await cleanupSessionStateForTest({ stateDir });
      } finally {
        envSnapshot.restore();
        remove();
      }
    });
  });

  beforeEach(async () => {
    stateDir = await fs.realpath(tempDirs.make("openclaw-voice-digest-retry-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    sendDurableMessageBatch.mockReset().mockResolvedValue({ status: "sent" });
  });

  return {
    sendDurableMessageBatch,
    get stateDir() {
      return stateDir;
    },
  };
}

/** Give each delivery attempt its real settlement barrier without sealing later test phases. */
export async function withClientVoiceDigestSettlement(
  run: (settle: () => Promise<void>) => Promise<void>,
): Promise<void> {
  let close = prepareClientVoiceSessionClose();
  try {
    await run(async () => {
      await close.drain();
      close = prepareClientVoiceSessionClose();
    });
  } finally {
    await close.drain();
  }
}
