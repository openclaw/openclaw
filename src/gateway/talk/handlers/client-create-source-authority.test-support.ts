import { copyFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { captureGatewayToolReceiptAssertion } from "../../../agents/tools/gateway-caller-context.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../../config/sessions/session-accessor.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
} from "../../../config/sessions/session-source-authority.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db-lifecycle.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import * as voiceWriters from "../../../talk/client-voice-session-write.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { createBrowserHarness, type EnsureHarness } from "./client-create-ensure.test-support.js";
import { browserSession, observeTalkVoiceChangeRequest } from "./client-fixtures.test-support.js";
import { talkVoiceHandlers } from "./voice.js";

type SourceAuthorityHarness = Omit<EnsureHarness, "ownVoice"> & {
  ownVoice: (id: string | undefined, key?: string) => void;
  sessionKey: string;
  sessionId: string;
};

export function registerClientCreateSourceAuthorityTests(harness: SourceAuthorityHarness) {
  const { sessionKey, sessionId, observeAdmission: setObserver } = harness;
  const browser = (voiceSessionId: string, key = sessionKey) =>
    createBrowserHarness(harness, { sessionKey: key, provider: "openai", voiceSessionId });
  it.each(["missing", "idless"] as const)(
    "keeps the acknowledged %s creation bound to its original physical source",
    async (kind) => {
      const key = `agent:main:created-source-${kind}`;
      harness.ownVoice(undefined, key);
      if (kind === "idless") {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: key },
          { sessionId: "", updatedAt: 1 },
        );
      }
      const fixture = browser("created-source-voice", key);
      const sourcePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const displacedPath = `${sourcePath}.committed`;
      const ensure = voiceWriters.ensureClientVoiceAgentSessionEntry;
      let replaced = false;
      let successorBytes: Buffer | undefined;
      const ensureSpy = vi
        .spyOn(voiceWriters, "ensureClientVoiceAgentSessionEntry")
        .mockImplementationOnce(async (params) => {
          const ensuredId = await ensure(params);
          await closeOpenClawAgentDatabasesAsync(harness.tempDir());
          renameSync(sourcePath, displacedPath);
          copyFileSync(displacedPath, sourcePath);
          successorBytes = readFileSync(sourcePath);
          replaced = true;
          return ensuredId;
        });
      try {
        await fixture.create();
        expect(replaced).toBe(true);
        expect(ensureSpy).toHaveBeenCalledOnce();
        expect(fixture.reply?.[0]).toBe(false);
        expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
        await closeOpenClawAgentDatabasesAsync(harness.tempDir());
        expect(readFileSync(sourcePath)).toEqual(successorBytes);
      } finally {
        ensureSpy.mockRestore();
        await closeOpenClawAgentDatabasesAsync(harness.tempDir());
        if (replaced) {
          unlinkSync(sourcePath);
          renameSync(displacedPath, sourcePath);
        }
      }
    },
  );

  it("refuses ordinary voice creation when its session changes during worker preparation", async () => {
    const voiceSessionId = "voice-revoked-before-commit";
    const fixture = browser(voiceSessionId);
    let creatingVoice = false;
    let revoked = false;
    const create = voiceSessions.createOrResumeClientVoiceSession;
    const createSpy = vi
      .spyOn(voiceSessions, "createOrResumeClientVoiceSession")
      .mockImplementation(async (...args) => {
        creatingVoice = true;
        try {
          return await create(...args);
        } finally {
          creatingVoice = false;
        }
      });
    setObserver((request, run) => {
      if (creatingVoice && !revoked && request.stage === "prepare") {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          { sessionId: "replacement", updatedAt: Date.now() },
        );
        revoked = true;
      }
      run();
    });
    try {
      await fixture.create();
      expect(revoked).toBe(true);
      expect(fixture.reply?.[0]).toBe(false);
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toBeUndefined();
      expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
    } finally {
      createSpy.mockRestore();
      setObserver(undefined);
    }
  });

  it.each([
    ...["commit", "transport"].flatMap((guard) =>
      [false, true].map((revoked) => ({ replacement: false, guard, revoked })),
    ),
    ...["commit", "receipt", "transport"].flatMap((guard) =>
      [false, true].map((revoked) => ({ replacement: true, guard, revoked })),
    ),
  ])(
    "retains the native $guard SDK guard (replacement=$replacement, revoked=$revoked)",
    async ({ replacement, guard, revoked }) => {
      const fixture = createBrowserHarness(
        harness,
        {
          sessionKey,
          ...(replacement
            ? { capabilities: ["voice-selection"] }
            : { provider: "openai", voiceSessionId: "voice-sdk-guard" }),
        },
        async (request) =>
          replacement ? { ...browserSession, voice: request.voice ?? "cove" } : browserSession,
      );
      let voiceSessionId: string | undefined = replacement ? undefined : "voice-sdk-guard";
      let nativeCommitGuard = false;
      let inGrant = false;
      if (replacement) {
        Object.assign(fixture.provider, { voices: ["cove", "ember"] });
        await fixture.create();
        expect(fixture.reply?.[0]).toBe(true);
        harness.ownVoice(fixture.reply?.[1].voiceSessionId);
        fixture.createBrowserSession.mock.calls[0]?.[0].gatewayControl?.onReady?.();
      }
      const createVoice = voiceSessions.createOrResumeClientVoiceSession;
      const spy = replacement
        ? vi
            .spyOn(voiceSessions, "createOrResumeClientVoiceSession")
            .mockImplementation(async (...args) => {
              voiceSessionId = args[0].voiceSessionId;
              return createVoice(...args);
            })
        : undefined;
      setObserver((_request, run) => {
        const previous = inGrant;
        inGrant = true;
        try {
          run();
        } finally {
          inGrant = previous;
        }
      });
      const readSdkCurrent = () => {
        expect(inGrant, "SDK reads must stay outside worker grants").toBe(false);
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sessionId);
        if (
          voiceSessionId &&
          getOpenClawAgentDatabaseIfOpen({ agentId: "main" })?.db.isTransaction &&
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)
        ) {
          nativeCommitGuard = true;
          return !revoked;
        }
        return true;
      };
      const error = replacement ? "Replacement SDK authority revoked" : "SDK authority revoked";
      const assertSdkCurrent = () => {
        if (!readSdkCurrent()) {
          throw new Error(error);
        }
      };
      const authority =
        guard === "transport"
          ? {
              hasCurrentClientAuthority: replacement
                ? () => {
                    assertSdkCurrent();
                    return true;
                  }
                : readSdkCurrent,
            }
          : {
              sessionMutationCommitGuard:
                guard === "receipt"
                  ? captureGatewayToolReceiptAssertion(
                      composeSessionSourceAssertion([
                        captureExternalSessionCommitGuard(assertSdkCurrent),
                      ]),
                    )
                  : assertSdkCurrent,
            };
      let change: Promise<unknown> | undefined;
      try {
        if (replacement) {
          const wait = observeTalkVoiceChangeRequest(fixture.context.broadcastToConnIds);
          change = Promise.resolve(
            talkVoiceHandlers["talk.voice.set"]!({
              req: { type: "req", id: "sdk-change", method: "talk.voice.set", params: {} },
              params: {
                voiceSessionId: fixture.reply?.[1].voiceSessionId,
                voice: "ember",
              },
              respond: vi.fn(),
              context: fixture.context,
              client: fixture.client,
              isWebchatConnect: () => false,
              ...authority,
            } as never),
          );
          await wait(change);
          const changeId = fixture.context.broadcastToConnIds.mock.calls.find(
            ([event]) => event === "talk.voice.change",
          )?.[1]?.changeId;
          expect(changeId).toBeTypeOf("string");
          await fixture.create({ voiceChangeId: changeId });
        } else {
          await fixture.create({}, authority);
        }
        expect(nativeCommitGuard, fixture.reply?.[2]?.message).toBe(true);
        if (!voiceSessionId) {
          throw new Error("Voice metadata creation was not reached");
        }
        expect(fixture.reply?.[0], fixture.reply?.[2]?.message).toBe(!revoked);
        if (revoked) {
          expect(fixture.reply?.[2]?.message).toContain(
            !replacement && guard === "transport" ? "Gateway requester authority changed" : error,
          );
          expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toBeUndefined();
          expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
        } else {
          harness.ownVoice(voiceSessionId);
          expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
        }
      } finally {
        spy?.mockRestore();
        if (replacement) {
          cleanupTalkConnection(fixture.client.connId, fixture.context.logGateway);
          await change;
        }
      }
    },
  );
}
