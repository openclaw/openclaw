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
import type { SqliteWorkerAdmissionRequest } from "../../../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db-lifecycle.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import * as voiceWriters from "../../../talk/client-voice-session-write.js";
import * as voiceSessions from "../../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import { cleanupTalkConnection } from "../session-registry.js";
import {
  browserSession,
  type BrowserRequest,
  type createDelegatedBrowserProviderFixture,
} from "./client-fixtures.test-support.js";
import { talkVoiceHandlers } from "./voice.js";

type SourceAuthorityHarness = {
  tempDir: () => string;
  ownVoice: (id: string | undefined, key?: string) => void;
  configureProvider: (
    create: (request: BrowserRequest) => Promise<typeof browserSession>,
  ) => ReturnType<typeof createDelegatedBrowserProviderFixture>;
  invokeCreate: (options: GatewayRequestHandlerOptions) => Promise<void>;
  observeAdmission: (
    observer: ((request: SqliteWorkerAdmissionRequest, run: () => void) => void) | undefined,
  ) => void;
  sessionKey: string;
  sessionId: string;
};

export function registerClientCreateSourceAuthorityTests(harness: SourceAuthorityHarness) {
  const { sessionKey, sessionId, observeAdmission: setObserver } = harness;
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
      const fixture = harness.configureProvider(async () => browserSession);
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
      const respond = vi.fn();
      try {
        await harness.invokeCreate({
          params: { sessionKey: key, provider: "openai", voiceSessionId: "created-source-voice" },
          respond,
          context: fixture.context,
          client: fixture.client,
        } as never);
        expect(replaced).toBe(true);
        expect(ensureSpy).toHaveBeenCalledOnce();
        expect(respond.mock.lastCall?.[0]).toBe(false);
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
    const fixture = harness.configureProvider(async () => browserSession);
    const voiceSessionId = "voice-revoked-before-commit";
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
    const respond = vi.fn();
    try {
      await harness.invokeCreate({
        params: { sessionKey, provider: "openai", voiceSessionId },
        respond,
        context: fixture.context,
        client: fixture.client,
      } as never);
      expect(revoked).toBe(true);
      expect(respond.mock.lastCall?.[0]).toBe(false);
      expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toBeUndefined();
      expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
    } finally {
      createSpy.mockRestore();
      setObserver(undefined);
    }
  });

  it.each([
    ...[false, true].flatMap((receipt) =>
      [false, true].map((revoked) => ({ receipt, revoked, transport: false })),
    ),
    ...[false, true].map((revoked) => ({ receipt: false, revoked, transport: true })),
  ])(
    "retains a replacement source SDK guard at native commit (revoked=$revoked, receipt=$receipt) transport=$transport",
    async ({ revoked, receipt, transport }) => {
      const createBrowserSession = vi.fn(async (request: BrowserRequest) => ({
        ...browserSession,
        voice: request.voice ?? "cove",
      }));
      const fixture = harness.configureProvider(createBrowserSession);
      Object.assign(fixture.provider, { voices: ["cove", "ember"] });
      const respond = vi.fn();
      const create = (params: Record<string, unknown>) =>
        harness.invokeCreate({
          params: { sessionKey, capabilities: ["voice-selection"], ...params },
          respond,
          context: fixture.context,
          client: fixture.client,
        } as never);
      await create({});
      expect(respond.mock.lastCall?.[0]).toBe(true);
      const ownedVoiceSessionId = respond.mock.lastCall?.[1].voiceSessionId;
      harness.ownVoice(ownedVoiceSessionId);
      createBrowserSession.mock.calls[0]?.[0].gatewayControl?.onReady?.();
      let replacementId: string | undefined;
      const createVoice = voiceSessions.createOrResumeClientVoiceSession;
      const createSpy = vi
        .spyOn(voiceSessions, "createOrResumeClientVoiceSession")
        .mockImplementation(async (...args) => {
          replacementId = args[0].voiceSessionId;
          return createVoice(...args);
        });
      let nativeCommitGuard = false;
      let inGrant = false;
      setObserver((_request, run) => {
        const previous = inGrant;
        inGrant = true;
        try {
          run();
        } finally {
          inGrant = previous;
        }
      });
      const assertSdkCurrent = () => {
        expect(inGrant, "Replacement SDK reads must stay outside worker grants").toBe(false);
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sessionId);
        if (
          replacementId &&
          getOpenClawAgentDatabaseIfOpen({ agentId: "main" })?.db.isTransaction &&
          clientVoiceSessionTesting.readRecord("main", replacementId)
        ) {
          nativeCommitGuard = true;
          if (revoked) {
            throw new Error("Replacement SDK authority revoked");
          }
        }
      };
      const change = Promise.resolve(
        talkVoiceHandlers["talk.voice.set"]!({
          req: { type: "req", id: "sdk-change", method: "talk.voice.set", params: {} },
          params: { voiceSessionId: ownedVoiceSessionId, voice: "ember" },
          respond: vi.fn(),
          context: fixture.context,
          client: fixture.client,
          isWebchatConnect: () => false,
          ...(transport
            ? {
                hasCurrentClientAuthority: () => {
                  assertSdkCurrent();
                  return true;
                },
              }
            : {
                sessionMutationCommitGuard: receipt
                  ? captureGatewayToolReceiptAssertion(
                      composeSessionSourceAssertion([
                        captureExternalSessionCommitGuard(assertSdkCurrent),
                      ]),
                    )
                  : assertSdkCurrent,
              }),
        } as never),
      );
      const changeId = fixture.context.broadcastToConnIds.mock.calls.find(
        ([event]) => event === "talk.voice.change",
      )?.[1]?.changeId;
      expect(changeId).toBeTypeOf("string");
      try {
        await create({ voiceChangeId: changeId });
        expect(nativeCommitGuard, respond.mock.lastCall?.[2]?.message).toBe(true);
        if (!replacementId) {
          throw new Error("Voice metadata creation was not reached");
        }
        expect(respond.mock.lastCall?.[0]).toBe(!revoked);
        if (revoked) {
          expect(respond.mock.lastCall?.[2]?.message).toContain(
            "Replacement SDK authority revoked",
          );
          expect(clientVoiceSessionTesting.readRecord("main", replacementId)).toBeUndefined();
          expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
        } else {
          harness.ownVoice(replacementId);
          expect(clientVoiceSessionTesting.readRecord("main", replacementId)?.status).toBe("open");
        }
      } finally {
        createSpy.mockRestore();
        cleanupTalkConnection(fixture.client.connId, fixture.context.logGateway);
        await change;
      }
    },
  );

  it.each([
    { guard: "commit", revoked: false },
    { guard: "commit", revoked: true },
    { guard: "transport", revoked: false },
    { guard: "transport", revoked: true },
  ] as const)(
    "retains a released SDK's SQLite-reading $guard guard inside the native voice commit (revoked=$revoked)",
    async ({ guard, revoked }) => {
      const fixture = harness.configureProvider(async () => browserSession);
      const voiceSessionId = "voice-sdk-guard";
      let committedGuard = false;
      let inGrant = false;
      setObserver((_request, run) => {
        inGrant = true;
        try {
          run();
        } finally {
          inGrant = false;
        }
      });
      const readSdkCurrent = () => {
        expect(inGrant, "Opaque SDK reads must stay outside worker grants").toBe(false);
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sessionId);
        if (
          getOpenClawAgentDatabaseIfOpen({ agentId: "main" })?.db.isTransaction &&
          clientVoiceSessionTesting.readRecord("main", voiceSessionId)
        ) {
          committedGuard = true;
          return !revoked;
        }
        return true;
      };
      const respond = vi.fn();
      await harness.invokeCreate({
        params: { sessionKey, provider: "openai", voiceSessionId },
        respond,
        context: fixture.context,
        client: fixture.client,
        ...(guard === "transport"
          ? { hasCurrentClientAuthority: readSdkCurrent }
          : {
              sessionMutationCommitGuard: () => {
                if (!readSdkCurrent()) {
                  throw new Error("SDK authority revoked");
                }
              },
            }),
      } as never);
      expect(committedGuard, respond.mock.lastCall?.[2]?.message).toBe(true);
      expect(respond.mock.lastCall?.[0], respond.mock.lastCall?.[2]?.message).toBe(!revoked);
      if (revoked) {
        expect(respond.mock.lastCall?.[2]?.message).toContain(
          guard === "transport" ? "Gateway requester authority changed" : "SDK authority revoked",
        );
        expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toBeUndefined();
        expect(fixture.cancelBrowserSession).toHaveBeenCalledOnce();
      } else {
        harness.ownVoice(voiceSessionId);
        expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
      }
    },
  );
}
