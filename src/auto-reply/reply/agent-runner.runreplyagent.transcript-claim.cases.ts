import { expect, it, type Mock } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { claimAgentSessionWriter } from "../../agents/embedded-agent-runner/run/session-bootstrap.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";

type TranscriptClaimFixture = {
  createMinimalRun: (params: {
    sessionCtx: Partial<TemplateContext>;
    sourceTurnId: string;
    runOverrides: Partial<FollowupRun["run"]>;
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    sessionKey: string;
    storePath: string;
  }) => { run: () => Promise<ReplyPayload | ReplyPayload[] | undefined> };
  makeSessionFixture: (overrides: Partial<SessionEntry>) => Promise<{
    sessionEntry: SessionEntry;
    sessionStore: Record<"main", SessionEntry>;
    storePath: string;
  }>;
  readStoredMainSession: (storePath: string) => Promise<SessionEntry>;
  runEmbeddedAgentMock: Pick<Mock, "mockImplementationOnce" | "mock">;
};

export function registerTranscriptClaimCases({
  createMinimalRun,
  makeSessionFixture,
  readStoredMainSession,
  runEmbeddedAgentMock,
}: TranscriptClaimFixture): void {
  it.each([
    {
      label: "legacy fingerprint",
      fingerprint: "request-fingerprint",
      fullId: undefined,
      sourceTurnId: "channel-user:v1:different-from-gateway-run",
      final: "visible final",
    },
    {
      label: "short id differing from the full id",
      fingerprint: undefined,
      fullId: "provider-full-msg",
      sourceTurnId: "channel-user:v1:control-ui-run",
      final: "final",
    },
  ])(
    "adopts a transcript-only claim by $label and preserves its pending final",
    async (testCase) => {
      const { sessionEntry, sessionStore, storePath } = await makeSessionFixture({
        abortedLastRun: false,
        restartRecoveryDeliveryRequestFingerprint: testCase.fingerprint,
        restartRecoveryDeliveryRunId: "msg",
        restartRecoveryDeliverySourceRunId: "control-ui-run",
      });
      runEmbeddedAgentMock.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
        // Native execution adopts the durable input when its lane claims the session writer.
        await claimAgentSessionWriter(params);
        const storedDuringRun = await readStoredMainSession(storePath);
        expect(storedDuringRun.restartRecoveryBeforeAgentReplyState).toBeUndefined();
        expect(storedDuringRun.restartRecoveryDeliveryContext).toBeUndefined();
        expect(storedDuringRun.restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
        expect(typeof storedDuringRun.restartRecoveryDeliveryRunId).toBe("string");
        expect(storedDuringRun.restartRecoveryDeliverySourceRunId).toBe("control-ui-run");
        expect(storedDuringRun.restartRecoverySourceIngress).toBe("control-ui");
        return {
          payloads: [{ text: testCase.final }],
          meta: {},
        };
      });

      const { run } = createMinimalRun({
        sessionCtx: {
          MessageSid: "msg",
          MessageSidFull: testCase.fullId,
          Provider: "webchat",
          OriginatingChannel: "webchat",
        },
        sourceTurnId: testCase.sourceTurnId,
        runOverrides: { messageProvider: "webchat" },
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });

      await expect(run()).resolves.toEqual(expect.objectContaining({ text: testCase.final }));

      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
      expect(sessionStore.main.restartRecoveryTerminalRunIds).toEqual(["control-ui-run"]);
      const stored = await readStoredMainSession(storePath);
      expect(stored.restartRecoveryDeliveryContext).toBeUndefined();
      expect(stored.restartRecoveryBeforeAgentReplyState).toBeUndefined();
      expect(stored.restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
      expect(stored.restartRecoveryDeliveryRunId).toBeUndefined();
      expect(stored.restartRecoveryDeliverySourceRunId).toBeUndefined();
      expect(stored.pendingFinalDelivery).toMatchObject({
        kind: "replayable",
        text: testCase.final,
        context: { channel: "webchat" },
        intentId: expect.any(String),
        createdAt: expect.any(Number),
      });
      expect(stored.restartRecoverySourceIngress).toBe("control-ui");
      expect(stored.restartRecoveryTerminalRunIds).toEqual(["control-ui-run"]);
    },
  );
}
