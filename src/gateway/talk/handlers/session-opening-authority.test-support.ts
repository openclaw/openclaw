import { expect, it, vi, type Mock } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import { resolveSessionMutationAuthorizationAsync } from "../../session-sharing-authorization-async.js";
import { makeRelayTransport } from "../relay/index.test-support.js";
import { closeRelaySession, sendTalkRealtimeRelayAudio } from "../relay/operations.js";
import { relaySessions } from "../relay/state.js";
import {
  createDelegatedBrowserProviderFixture,
  browserSession,
} from "./client-fixtures.test-support.js";
import { talkSessionHandlers } from "./session.js";

/** Real admission facts must outlive the create RPC, not the opening or relay close. */
export function registerRelayOpeningAuthorityTests(harness: {
  tempDir: () => string;
  providerResolution: Mock;
  sessionKey: string;
}) {
  it.each([
    "greeting",
    "recovery",
    "short-recovery",
    "closed",
    "revoked",
    "provider-error",
    "provider-event-error",
  ] as const)(
    "settles deferred relay opening authority after request release: %s",
    async (outcome) => {
      const fixture = createDelegatedBrowserProviderFixture(
        async () => browserSession,
        harness.tempDir(),
      );
      setRuntimeConfigSnapshot(fixture.context.getRuntimeConfig());
      let bridgeRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      const speak = vi.fn();
      harness.providerResolution.mockReturnValue({
        provider: {
          id: "test-relay",
          label: "Test Relay",
          isConfigured: () => true,
          createBridge: (request: RealtimeVoiceBridgeCreateRequest) => {
            bridgeRequest = request;
            if (outcome === "provider-error") {
              throw new Error("Synthetic provider setup failure");
            }
            return makeRelayTransport({ triggerGreeting: speak });
          },
        },
        providerConfig: {},
        capabilities: { transports: ["gateway-relay"] },
      });
      const params = {
        sessionKey: harness.sessionKey,
        mode: "realtime",
        transport: "gateway-relay",
        ...(outcome === "recovery" || outcome === "short-recovery"
          ? { recovery: { interruptedForMs: outcome === "recovery" ? 12_000 : 0 } }
          : { greeting: "Briefly explain the prepared topic." }),
      };
      const admission = await resolveSessionMutationAuthorizationAsync({
        method: "talk.session.create",
        requestParams: params,
        client: fixture.client as never,
        context: fixture.context as never,
      });
      expect(admission.error).toBeNull();
      const authorization = admission.authorization!;
      const releaseOpening = vi.fn();
      const retain = authorization.retain!;
      const retainSpy = vi.spyOn(authorization, "retain").mockImplementation(() => {
        const release = retain();
        return () => {
          releaseOpening();
          release();
        };
      });
      const respond = vi.fn();
      try {
        await talkSessionHandlers["talk.session.create"]!({
          req: { type: "req", id: "opening", method: "talk.session.create" },
          params,
          respond,
          client: fixture.client as never,
          context: fixture.context as never,
          isWebchatConnect: () => false,
          sessionMutationAuthorization: authorization,
        });
      } finally {
        authorization.release?.();
      }
      if (outcome === "provider-error") {
        expect(respond.mock.lastCall?.[0]).toBe(false);
        expect(retainSpy).toHaveBeenCalledOnce();
        expect(releaseOpening).toHaveBeenCalledOnce();
        return;
      }
      expect(respond.mock.lastCall?.[0], respond.mock.lastCall?.[2]?.message).toBe(true);
      expect(releaseOpening).not.toHaveBeenCalled();
      const relay = relaySessions.get(respond.mock.lastCall?.[1].sessionId)!;
      expect(relay).toBeDefined();
      try {
        if (outcome === "closed") {
          await closeRelaySession(relay, "completed");
        } else {
          if (outcome === "revoked") {
            await replaceSessionEntry(
              { agentId: "main", sessionKey: harness.sessionKey },
              { sessionId: "replacement-session", updatedAt: Date.now() },
            );
          }
          await sendTalkRealtimeRelayAudio({
            relaySessionId: relay.id,
            connId: fixture.client.connId,
            audioBase64: Buffer.alloc(960).toString("base64"),
          });
        }
        if (outcome === "provider-event-error") {
          bridgeRequest?.onError?.(new Error("Synthetic provider failure before readiness"));
        }
        bridgeRequest?.onReady?.();
        const shouldSpeak = outcome === "greeting" || outcome === "recovery";
        expect(speak).toHaveBeenCalledTimes(shouldSpeak ? 1 : 0);
        expect(releaseOpening).toHaveBeenCalledOnce();
        bridgeRequest?.onReady?.();
        expect(speak).toHaveBeenCalledTimes(shouldSpeak ? 1 : 0);
      } finally {
        await closeRelaySession(relay, "completed");
      }
      expect(retainSpy).toHaveBeenCalledOnce();
      expect(releaseOpening).toHaveBeenCalledOnce();
    },
  );
}
