import fs from "node:fs/promises";
import { afterEach, beforeEach, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { prepareClientVoiceSessionClose } from "./client-voice-session-lifecycle.js";
import {
  createCompletedMutationSession,
  recordMutationEvents,
  seedSession,
} from "./client-voice-session.fixture.test-support.js";
import { closeClientVoiceSession, closeStaleClientVoiceSessions } from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

const { sendDurableMessageBatch } = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(async () => ({ status: "sent" })),
}));
const acceptedDigestWork = vi.hoisted(() => new Set<Promise<void>>());

vi.mock("./client-voice-session-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client-voice-session-lifecycle.js")>();
  return {
    ...actual,
    captureClientVoiceSessionSettlement(
      ...args: Parameters<typeof actual.captureClientVoiceSessionSettlement>
    ) {
      const accepted = actual.captureClientVoiceSessionSettlement(...args);
      const completed = createDeferred();
      acceptedDigestWork.add(completed.promise);
      return {
        run<T>(run: () => T): T {
          return accepted.run(run);
        },
        release() {
          try {
            accepted.release();
          } finally {
            acceptedDigestWork.delete(completed.promise);
            completed.resolve();
          }
        },
      };
    },
  };
});

async function settleDigestAttempts(): Promise<void> {
  while (acceptedDigestWork.size > 0) {
    await Promise.all(acceptedDigestWork);
  }
}

vi.mock("../channels/message/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/message/runtime.js")>();
  return {
    ...actual,
    sendDurableMessageBatchCore: sendDurableMessageBatch,
  };
});

export function useClientVoiceDigestHarness() {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let stateDir: string;
  const tempDirs = useAutoCleanupTempDirTracker((remove) => {
    afterEach(async () => {
      await settleDigestAttempts();
      clientVoiceSessionTesting.reset();
      try {
        await cleanupSessionStateForTest({ stateDir });
      } finally {
        envSnapshot.restore();
        remove();
      }
    });
  });

  beforeEach(async ({ onTestFinished }) => {
    stateDir = await fs.realpath(tempDirs.make("openclaw-voice-digest-retry-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    sendDurableMessageBatch.mockReset().mockResolvedValue({ status: "sent" });
    setRuntimeConfigSnapshot({});
    onTestFinished(clearRuntimeConfigSnapshot);
  });

  return {
    sendDurableMessageBatch,
    settleDigestAttempts,
    async seedDigest(this: void, to = "channel:voice-updates") {
      await seedSession("agent:main:main", { channel: "discord", to });
      return createCompletedMutationSession();
    },
    holdSend(this: void) {
      const sending = createDeferred();
      const finishSend = createDeferred();
      sendDurableMessageBatch.mockImplementationOnce(async () => {
        sending.resolve();
        await finishSend.promise;
        return { status: "sent" };
      });
      return { sending, finishSend };
    },
    readRecord: (id: string) => clientVoiceSessionTesting.readRecord("main", id),
    closeVoice: (
      voiceSessionId: string,
      params: Partial<Parameters<typeof closeClientVoiceSession>[0]> = {},
    ) =>
      closeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        config: {},
        ...params,
        voiceSessionId,
      }),
    recoverStale: (params: Partial<Parameters<typeof closeStaleClientVoiceSessions>[0]> = {}) =>
      closeStaleClientVoiceSessions({ agentId: "main", config: {}, ...params }),
    recordEffect(this: void, runId: string, toolCallId: string) {
      recordMutationEvents(runId, toolCallId);
    },
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
