import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  replaceSessionEntry,
  readSessionTranscriptMessageEvents,
} from "../../config/sessions/session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readVoiceSessionRecord } from "../../talk/client-voice-session-store.js";
import { createOrResumeClientVoiceSession } from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareTalkSessionTarget } from "../talk-session-target.js";
import { talkClientHandlers } from "./talk-client.js";
import type { RespondFn } from "./types.js";

const agentId = "voice";
const sessionKey = "agent:voice:queued-authority";
const sessionId = "queued-voice-authority";
const voiceSessionId = "voice-queued-authority";
const methods = ["talk.client.transcript", "talk.client.close"] as const;
const guards = ["request", "gateway", "session"] as const;

afterEach(() => {
  clientVoiceSessionTesting.reset();
  clearRuntimeConfigSnapshot();
});

describe.each(methods)("%s queued mutation authority", (method) => {
  it.each(guards)("rejects when the %s owner closes after the initial check", async (guard) => {
    await withOpenClawTestState({ label: "talk-rpc-queued-authority" }, async () => {
      const cfg = { agents: { entries: { main: {}, voice: {} } } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const database = openOpenClawAgentDatabase({ agentId });
      const storePath = database.path;
      await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 1 });
      createOrResumeClientVoiceSession({ agentId, sessionKey, voiceSessionId, origin: "client" });
      const gate = createDeferredCore();
      const held = runExclusiveSqliteSessionWrite(
        { agentId, path: storePath },
        () => gate.promise,
        "session.transcript.locked-write",
      );
      const controller = new AbortController();
      let current = true;
      let initiallyChecked = false;
      const assertCurrent = () => {
        initiallyChecked = true;
        if (guard === "session" && !current) {
          throw new Error("session authorization revoked");
        }
      };
      const params = {
        sessionKey,
        voiceSessionId,
        ...(method === "talk.client.transcript"
          ? { entryId: "revoked-utterance", role: "user", text: "yes" }
          : {}),
      };
      const respond = vi.fn<RespondFn>();
      const context = { getRuntimeConfig: () => cfg };
      const invocation = Promise.resolve(
        talkClientHandlers[method]({
          req: { type: "req", id: "queued-authority", method, params },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond,
          context,
          signal: controller.signal,
          sessionMutationCommitGuard: () => {
            if (guard === "gateway" && !current) {
              throw new Error("gateway owner closed");
            }
          },
          sessionMutationAuthorization: {
            talkSessionTarget: prepareTalkSessionTarget(cfg, sessionKey),
            assertCurrent,
            assertTargetCurrent: assertCurrent,
          },
        }),
      );
      void invocation.catch(() => {});
      try {
        await vi.waitFor(() => expect(initiallyChecked).toBe(true));
        current = false;
        if (guard === "request") {
          controller.abort(new Error("request cancelled"));
        }
      } finally {
        gate.resolve();
        await Promise.all([held, invocation]);
      }
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(readVoiceSessionRecord(agentId, voiceSessionId)).toMatchObject({ status: "open" });
      expect(readVoiceSessionRecord(agentId, voiceSessionId)?.hasUserTranscript).not.toBe(true);
      expect(
        readSessionTranscriptMessageEvents({ agentId, sessionKey, sessionId, storePath }),
      ).toEqual([]);
    });
  });
});
