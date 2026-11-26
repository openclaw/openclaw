import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTranscriptionProviderPlugin } from "../../plugins/types.js";
import type { RealtimeTranscriptionSessionCreateRequest } from "../../realtime-transcription/provider-contexts.js";
import {
  createVocabularySnapshot,
  type VocabularySnapshotLease,
  type VocabularyStage,
} from "../../realtime-transcription/vocabulary-snapshot.js";
import type { VocabularyGrant } from "../../realtime-transcription/vocabulary-types.js";
import { cleanupTalkConnection } from "./session-registry.js";
import {
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "./transcription-relay.js";

// Isolate unrelated file-provider discovery, durable voice persistence, and diagnostics.
// The relay, Talk event controller, session cleanup, and vocabulary lease are real.
// mock-isolation: Realtime-only tests never call the file-provider discovery path.
vi.mock("./file-transcription.js", () => ({ createTalkFileTranscriptionSession: vi.fn() }));
// mock-isolation: This boundary suite captures owner events without process diagnostics I/O.
vi.mock("../../talk/observability.js", () => ({ recordTalkObservabilityEvent: vi.fn() }));
// mock-isolation: Connection cleanup is exercised without durable voice database admission.
vi.mock("../../talk/client-voice-session-lifecycle.js", () => ({
  prepareClientVoiceSessionClose: vi.fn(),
  withClientVoiceSessionSettlement: vi.fn(),
}));

const leases: VocabularySnapshotLease[] = [];
const connId = "vocabulary-fixture-connection";
const confidential = "FictionalPrivateVocabulary";

async function vocabularyFixture(stage: VocabularyStage = "stt", providerId = "fixture-stt") {
  let current = true;
  const listeners = new Set<() => void>();
  const grant: VocabularyGrant = {
    actorId: "fixture-person",
    expiresAt: Date.now() + 60_000,
    assertCurrent: () => {
      if (!current) {
        throw new Error("Fixture membership revoked");
      }
    },
    revalidate: async () => grant.assertCurrent(),
    onInvalidated: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const lease = await createVocabularySnapshot({
    authority: { authorize: async () => grant },
    collections: [
      {
        grant,
        collection: {
          schemaVersion: 1,
          scopeId: "fixture-workspace",
          collectionId: "fixture-collection",
          revision: 1,
          updatedAt: 1,
          audit: [],
          deleted: false,
          label: "Fixture",
          terms: [{ id: "term", canonical: confidential, aliases: [], locales: [], enabled: true }],
        },
      },
    ],
    personalRevision: 0,
    providerId,
    // Synthetic encoder, not a claim about any live provider's vocabulary support.
    capability: {
      kind: "canonical-list",
      maxTerms: 1,
      maxBytes: 100,
      maxTokens: 100,
      measure: (terms) => ({
        bytes: Buffer.byteLength(JSON.stringify(terms)),
        tokens: JSON.stringify(terms).length,
      }),
    },
    expiresAt: Date.now() + 60_000,
  });
  leases.push(lease);
  return {
    vocabulary: await lease.prepareEgress(stage),
    revoke: () => {
      current = false;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function relayFixture() {
  const events: unknown[] = [];
  const logGateway = { warn: vi.fn() };
  const context = {
    getRuntimeConfig: () => ({}),
    logGateway,
    broadcastToConnIds: (_event: string, payload: unknown) => {
      events.push(payload);
    },
  } as never;
  const stt = {
    connect: vi.fn(async () => {}),
    sendAudio: vi.fn(),
    close: vi.fn(),
    isConnected: () => true,
  };
  let request: RealtimeTranscriptionSessionCreateRequest | undefined;
  const provider: RealtimeTranscriptionProviderPlugin = {
    id: "fixture-stt",
    label: "Fixture",
    isConfigured: () => true,
    createSession: vi.fn((value) => {
      request = value;
      return stt;
    }),
  };
  return {
    events,
    logGateway,
    stt,
    provider,
    params: { context, connId, assertCurrent: () => {}, provider, providerConfig: {} },
    callbacks: () => {
      if (!request) {
        throw new Error("Fixture did not capture callbacks");
      }
      return request;
    },
  };
}

function append(transcriptionSessionId: string) {
  sendTalkTranscriptionRelayAudio({ transcriptionSessionId, connId, audioBase64: "AQI=" });
}

describe("vocabulary at the existing Talk transcription relay boundary", () => {
  afterEach(async () => {
    cleanupTalkConnection(connId, { warn: () => {} });
    for (const lease of leases.splice(0)) {
      lease.release();
    }
    await Promise.resolve();
  });

  it.each(["revoked", "provider", "stage"] as const)(
    "rejects a %s lease before creating a provider session",
    async (reason) => {
      const selected = await vocabularyFixture(
        reason === "stage" ? "refinement" : "stt",
        reason === "provider" ? "another-provider" : "fixture-stt",
      );
      if (reason === "revoked") {
        selected.revoke();
      }
      const fixture = relayFixture();
      expect(() =>
        createTalkTranscriptionRelaySession({ ...fixture.params, vocabulary: selected.vocabulary }),
      ).toThrow("Vocabulary unavailable");
      expect(fixture.provider.createSession).not.toHaveBeenCalled();
      expect(fixture.events).toEqual([]);
    },
  );

  it("drops newly arriving hinted results after revocation without replay or undoing accepted events", async () => {
    const selected = await vocabularyFixture();
    const fixture = relayFixture();
    // The fixture observes the outgoing hints. No production adapter is qualified here.
    expect(selected.vocabulary.hints.terms).toEqual([confidential]);
    const { transcriptionSessionId } = createTalkTranscriptionRelaySession({
      ...fixture.params,
      vocabulary: selected.vocabulary,
    });
    await Promise.resolve();
    append(transcriptionSessionId);
    fixture.callbacks().onTranscript?.("Previously authorized material");
    append(transcriptionSessionId);
    const accepted = [...fixture.events];
    selected.revoke();
    const closed = [...fixture.events];
    fixture.callbacks().onPartial?.(confidential);
    fixture.callbacks().onTranscript?.(confidential);
    expect(fixture.events).toEqual(closed);
    expect(fixture.events.slice(0, accepted.length)).toEqual(accepted);
    expect(JSON.stringify(fixture.events)).not.toContain(confidential);
    expect(fixture.stt.close).toHaveBeenCalledOnce();
    expect(fixture.stt.sendAudio).toHaveBeenCalledTimes(2);
    expect(fixture.provider.createSession).toHaveBeenCalledOnce();
    expect(() => append(transcriptionSessionId)).toThrow("Unknown transcription Talk session");
  });

  it.each(["create", "connect", "append", "finish-sync", "finish-async", "close"] as const)(
    "redacts private provider details from %s failures and returned errors",
    async (operation) => {
      const selected = await vocabularyFixture();
      const fixture = relayFixture();
      const fail = () => {
        throw new Error(confidential);
      };
      if (operation === "create") {
        vi.mocked(fixture.provider.createSession).mockImplementation(fail);
      }
      if (operation === "connect") {
        fixture.stt.connect.mockImplementation(fail);
      }
      if (operation === "append") {
        fixture.stt.sendAudio.mockImplementation(fail);
      }
      if (operation === "close") {
        fixture.stt.close.mockImplementation(fail);
      }
      if (operation.startsWith("finish-")) {
        Object.assign(fixture.stt, {
          finish: operation === "finish-sync" ? fail : async () => fail(),
        });
      }
      await expect(
        Promise.resolve().then(async () => {
          const { transcriptionSessionId } = createTalkTranscriptionRelaySession({
            ...fixture.params,
            vocabulary: selected.vocabulary,
          });
          await Promise.resolve();
          append(transcriptionSessionId);
          await stopTalkTranscriptionRelaySession({ transcriptionSessionId, connId });
        }),
      ).rejects.toThrow("Vocabulary unavailable");
      expect(JSON.stringify(fixture.events)).not.toContain(confidential);
      expect(JSON.stringify(fixture.logGateway.warn.mock.calls)).not.toContain(confidential);
      expect(fixture.provider.createSession).toHaveBeenCalledOnce();
    },
  );

  it.each(["connect-rejection", "callback"] as const)(
    "redacts asynchronous %s errors without publishing a private message",
    async (operation) => {
      const selected = await vocabularyFixture();
      const fixture = relayFixture();
      if (operation === "connect-rejection") {
        fixture.stt.connect.mockRejectedValue(new Error(confidential));
      }
      createTalkTranscriptionRelaySession({ ...fixture.params, vocabulary: selected.vocabulary });
      if (operation === "callback") {
        fixture.callbacks().onError?.(new Error(confidential));
      }
      await vi.waitFor(() => expect(fixture.stt.close).toHaveBeenCalledOnce());
      expect(JSON.stringify(fixture.events)).toContain("Vocabulary unavailable");
      expect(JSON.stringify(fixture.events)).not.toContain(confidential);
    },
  );
});
