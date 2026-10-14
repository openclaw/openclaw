// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { RealtimeTalkSession } from "./session.ts";

type TransportRuntime = typeof import("./transport.runtime.ts");

afterEach(() => {
  vi.doUnmock("./transport.runtime.ts");
  vi.unstubAllGlobals();
});

it.each(["stopped", "failed"] as const)(
  "allocates no microphone or provider for a %s runtime load and releases its admission",
  async (outcome) => {
    const moduleReady = createDeferred<TransportRuntime>();
    const importStarted = createDeferred();
    vi.doMock("./transport.runtime.ts", () => {
      importStarted.resolve();
      return moduleReady.promise;
    });
    const getUserMedia = vi.fn(async () => {
      const track = Object.assign(new EventTarget(), { stop: vi.fn() });
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    let allocations = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "fixture",
          transport: "webrtc",
          voiceSessionId: `voice-runtime-${++allocations}`,
          clientSecret: "synthetic-session",
        };
      }
      if (method === "talk.client.close") {
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const createRealtimeTalkTransport = vi.fn<TransportRuntime["createRealtimeTalkTransport"]>(
      (_session, context) => ({
        start: async () => "ready",
        stop: () => context.input.stop(),
      }),
    );
    const runtime = { createRealtimeTalkTransport } satisfies TransportRuntime;
    const client = createTestGatewayClient(request);
    const session = new RealtimeTalkSession(client, "agent:main:runtime-load");
    const sibling = new RealtimeTalkSession(client, "agent:main:runtime-load");
    const starting = session.start();
    void starting.catch(() => undefined);
    try {
      await importStarted.promise;
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(createRealtimeTalkTransport).not.toHaveBeenCalled();

      if (outcome === "stopped") {
        await session.stop();
        moduleReady.resolve(runtime);
        await expect(starting).resolves.toBeUndefined();
      } else {
        const failure = new Error("Synthetic Talk runtime unavailable");
        moduleReady.reject(failure);
        await expect(starting).rejects.toHaveProperty("cause", failure);
        vi.doMock("./transport.runtime.ts", () => runtime);
      }
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(createRealtimeTalkTransport).not.toHaveBeenCalled();
      expect(session.getVoiceSessionId()).toBeUndefined();

      // Both supported call slots must remain usable; one retry alone can hide a leaked slot.
      await session.start();
      await sibling.start();
      expect(session.getVoiceSessionId()).toBe("voice-runtime-1");
      expect(sibling.getVoiceSessionId()).toBe("voice-runtime-2");
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(createRealtimeTalkTransport).toHaveBeenCalledTimes(2);
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "talk.client.create",
        "talk.client.create",
      ]);
    } finally {
      moduleReady.resolve(runtime);
      await starting.catch(() => undefined);
      await Promise.all([session.stop(), sibling.stop()]);
    }
  },
);
