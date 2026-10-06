import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { resetClientVoiceConfirmationStateForTest } from "./client-voice-confirmation.test-support.js";
import * as voiceSessionReads from "./client-voice-session-read.js";
import {
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";
import { VoiceTranscriptOperationRegistry } from "./voice-transcript.js";

describe("client voice session recovery", () => {
  let home: TempHomeEnv;
  beforeEach(async () => {
    home = await createTempHomeEnv("openclaw-voice-recovery-");
  });
  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    await home.restore();
  });

  it("closes stale records and leaves recent records open", async () => {
    const stale = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:stale",
      origin: "client",
      now: 1,
    });
    const recent = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:recent",
      origin: "client",
      now: 6 * 60 * 60_000,
    });

    expect(
      await closeStaleClientVoiceSessions({
        agentId: "main",
        config: {},
        now: 6 * 60 * 60_000 + 2,
      }),
    ).toBe(1);
    expect(clientVoiceSessionTesting.readRecord("main", stale)?.status).toBe("closed");
    expect(clientVoiceSessionTesting.readRecord("main", recent)?.status).toBe("open");
  });

  it("does not close a call resumed after the stale candidate read", async () => {
    const now = 6 * 60 * 60_000 + 2;
    const target = { agentId: "main", sessionKey: "agent:main:main", origin: "client" as const };
    const voiceSessionId = createOrResumeClientVoiceSession({ ...target, now: 1 });
    const lookup = voiceSessionReads.lookupClientVoiceSessions;
    const read = vi
      .spyOn(voiceSessionReads, "lookupClientVoiceSessions")
      .mockImplementationOnce(async (request) => {
        const candidates = await lookup(request);
        createOrResumeClientVoiceSession({ ...target, voiceSessionId, now });
        return candidates;
      });
    try {
      expect(await closeStaleClientVoiceSessions({ agentId: "main", config: {}, now })).toBe(0);
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
    } finally {
      read.mockRestore();
    }
  });

  it("honors an explicit close that joins skipped stale recovery", async () => {
    const now = 6 * 60 * 60_000 + 2;
    const target = { agentId: "main", sessionKey: "agent:main:main", origin: "client" as const };
    const voiceSessionId = createOrResumeClientVoiceSession({ ...target, now: 1 });
    const entered = createDeferred();
    const release = createDeferred();
    // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the original registry receiver.
    const close = VoiceTranscriptOperationRegistry.prototype.close;
    const barrier = vi
      .spyOn(VoiceTranscriptOperationRegistry.prototype, "close")
      .mockImplementationOnce(function (this: VoiceTranscriptOperationRegistry, key, operation) {
        return close.call(this, key, async () => {
          entered.resolve();
          await release.promise;
          await operation();
        });
      });
    const stale = closeStaleClientVoiceSessions({ agentId: "main", config: {}, now });
    try {
      await entered.promise;
      createOrResumeClientVoiceSession({ ...target, voiceSessionId, now });
      const explicit = closeClientVoiceSession({ ...target, voiceSessionId, config: {}, now });
      release.resolve();
      await Promise.all([stale, explicit]);
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("closed");
    } finally {
      release.resolve();
      await stale;
      barrier.mockRestore();
    }
  });
});
