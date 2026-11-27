// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayRequestContext } from "../../../../src/gateway/server-request-context.js";
import { makeContextParams } from "../../../../src/gateway/server-request-context.test-support.js";
import { cleanupTalkConnection } from "../../../../src/gateway/talk/session-registry.js";
import {
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "../../../../src/gateway/talk/transcription-relay.js";
import type { RealtimeTranscriptionProviderPlugin } from "../../../../src/plugins/types.js";
import type { RealtimeTranscriptionSessionCreateRequest } from "../../../../src/realtime-transcription/provider-contexts.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import {
  ComposerDictationRefinement,
  type ComposerRefinementScope,
} from "./composer-dictation-refinement.ts";
import { ComposerDictationSession } from "./composer-dictation-session.ts";
import {
  audioFixture,
  MockDictationAudioContext,
  type MockAudioProcessor,
} from "./talk/input.test-support.ts";

const cleanups: Array<() => Promise<void>> = [];
const processors: MockAudioProcessor[] = [];

class RecordingAudioContext extends MockDictationAudioContext {
  override createScriptProcessor(): MockAudioProcessor {
    const processor = super.createScriptProcessor();
    processors.push(processor);
    return processor;
  }
}

// The bridge replaces only Gateway transport and external audio/provider I/O.
// Capture, relay drain, Talk events, finality, refinement, and acceptance are real.
function fixture() {
  const connId = "dictation-refinement-relay-proof";
  const listeners = new Set<(frame: GatewayEventFrame) => void>();
  const media = audioFixture();
  const onError = vi.fn();
  let providerRequest: RealtimeTranscriptionSessionCreateRequest | undefined;
  const providerSession = {
    connect: async () => undefined,
    sendAudio: vi.fn(),
    close: vi.fn(() => providerRequest?.onTranscript?.("Do not delete customer_id.")),
    isConnected: () => true,
  };
  const provider: RealtimeTranscriptionProviderPlugin = {
    id: "dictation-relay-fixture",
    label: "Synthetic dictation relay",
    isConfigured: () => true,
    createSession: (request) => {
      providerRequest = request;
      return providerSession;
    },
  };
  const releaseAuthority = vi.fn();
  const context = createGatewayRequestContext(
    makeContextParams({
      broadcastToConnIds: (event, payload) => {
        for (const listener of listeners) {
          listener({ type: "event", event, payload });
        }
      },
    }),
  );
  context.getRuntimeConfig = () => ({});
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "talk.session.create") {
      const relay = createTalkTranscriptionRelaySession({
        context,
        connId,
        assertCurrent: () => undefined,
        releaseAuthority,
        provider,
        providerConfig: {},
      });
      return { ...relay, sessionId: relay.transcriptionSessionId };
    }
    if (typeof params.sessionId !== "string") {
      throw new Error("Expected a captured transcription session");
    }
    const target = { transcriptionSessionId: params.sessionId, connId };
    if (method === "talk.session.appendAudio" && typeof params.audioBase64 === "string") {
      sendTalkTranscriptionRelayAudio({ ...target, audioBase64: params.audioBase64 });
    } else if (method === "talk.session.close") {
      await stopTalkTranscriptionRelaySession({ ...target, discard: params.discard === true });
    } else {
      throw new Error(`Unexpected Gateway request: ${method}`);
    }
    return { ok: true };
  });
  // SAFETY: the browser session consumes only these external transport operations.
  const client = {
    request,
    addEventListener: (listener: (frame: GatewayEventFrame) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as GatewayBrowserClient;
  const scope: ComposerRefinementScope = {
    connection: client,
    connectionGeneration: 1,
    authority: {},
    accountId: "synthetic-account",
    target: "synthetic-draft",
    draftRevision: 0,
    draftText: "Existing draft.",
    permitted: true,
    locale: "en-US",
  };
  const commit = vi.fn((text: string) => {
    scope.draftText += ` ${text}`;
    scope.draftRevision += 1;
  });
  const review = new ComposerDictationRefinement({
    readScope: () => ({ ...scope }),
    changed: () => undefined,
    commit,
  });
  const session = new ComposerDictationSession(client, {
    onError,
    onReady: () => undefined,
    onTranscriptChange: () => undefined,
  });
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => media.stream) },
  });
  cleanups.push(async () => {
    review.cancel();
    await session.cancel().catch(() => undefined);
    cleanupTalkConnection(connId, context.logGateway);
  });
  return {
    session,
    review,
    scope,
    commit,
    media,
    onError,
    providerSession,
    releaseAuthority,
    transcript: (text: string) => providerRequest?.onTranscript?.(text),
    async start() {
      review.begin();
      await session.start();
      const processor = processors.at(-1);
      expect(processor?.onaudioprocess).toBeTypeOf("function");
      processor?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(160).fill(0.25) },
      });
      await vi.advanceTimersByTimeAsync(0);
      // An empty relay closes immediately and would hide the original defect.
      expect(providerSession.sendAudio).toHaveBeenCalledOnce();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", RecordingAudioContext);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  processors.length = 0;
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dictation review through the production transcription relay", () => {
  it("waits for the five-second drain and reviews every final before explicit insertion", async () => {
    const h = fixture();
    await h.start();
    const finished = h.review.finish(h.session);
    expect(h.media.track.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_501);
    expect(h.review.phase).toBe("finishing");
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.review.accept("candidate")).toBe(false);
    await vi.advanceTimersByTimeAsync(1_999);
    h.transcript("Keep the backup.");
    await vi.advanceTimersByTimeAsync(499);
    expect(h.review.phase).toBe("finishing");
    expect(h.releaseAuthority).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(finished).resolves.toBe(false);

    expect(h.review.result).toMatchObject({
      status: "refined",
      text: "Do not delete customer_id. Keep the backup.",
    });
    expect(h.review.incompleteCaption).toBe("");
    expect(h.scope.draftText).toBe("Existing draft.");
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.review.accept("candidate")).toBe(true);
    expect(h.scope.draftText).toBe("Existing draft. Do not delete customer_id. Keep the backup.");
    expect(h.review.accept("candidate")).toBe(false);
    expect(h.commit).toHaveBeenCalledOnce();
    expect(h.releaseAuthority).toHaveBeenCalledOnce();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("cancels a draining relay without accepting its later provider text", async () => {
    const h = fixture();
    await h.start();
    const finished = h.review.finish(h.session);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.review.phase).toBe("finishing");
    h.review.cancel();
    await vi.advanceTimersByTimeAsync(0);
    await expect(finished).resolves.toBe(false);
    expect(h.releaseAuthority).toHaveBeenCalledOnce();
    h.transcript("This arrived after cancellation.");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.review.phase).toBe("cancelled");
    expect(h.review.result).toBeUndefined();
    expect(h.review.accept("candidate")).toBe(false);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.scope.draftText).toBe("Existing draft.");
    expect(h.media.track.stop).toHaveBeenCalledOnce();
  });
});
