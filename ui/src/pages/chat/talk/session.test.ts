// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import * as fixture from "./session.test-support.ts";
import { RealtimeTalkSession, switchActiveRealtimeTalkCameras } from "./session.ts";

describe("RealtimeTalkSession", () => {
  it.each(["webrtc", "gateway-relay"] as const)(
    "claims a voice replacement once through its original %s create endpoint",
    async (transport) => {
      const request = vi.fn(async () => {
        throw new Error("replacement rejected");
      });
      const session = new RealtimeTalkSession(
        { request } as never,
        "agent:main:voice",
        {},
        { transport, voice: "spruce", voiceChangeId: "change-1" },
      );
      await expect(session.start()).rejects.toThrow("replacement rejected");
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(
        transport === "gateway-relay" ? "talk.session.create" : "talk.client.create",
        expect.objectContaining({
          sessionKey: "agent:main:voice",
          voice: "spruce",
          voiceChangeId: "change-1",
          transport,
          capabilities:
            transport === "gateway-relay"
              ? ["voice-selection"]
              : ["voice-transcript", "voice-selection"],
        }),
        fixture.requestTimeoutOptions,
      );
      void session.stop();
    },
  );

  it("closes a failed client-owned voice session after draining transcripts without hiding the error", async () => {
    const saved = createDeferred<unknown>();
    let generation = 0;
    const result = () => ({
      provider: "google",
      voiceSessionId: `voice-${++generation}`,
      transport: "provider-websocket",
      clientSecret: "test-session",
    });
    const request = fixture.voiceRequest(result, undefined, (method) =>
      method === "talk.client.transcript" ? saved.promise : undefined,
    );
    const onStatus = vi.fn();
    const session = fixture.sessionFor(request, { onStatus });
    await session.start();
    const ctx = fixture.transportContext(fixture.googleInstances[0]);
    fixture.publish(ctx, "Keep this utterance");
    ctx.callbacks.onStatus?.("error", "Microphone disconnected");
    ctx.callbacks.onTalkEvent?.({ type: "session.closed" });
    expect(fixture.googleStop).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenLastCalledWith("error", "Microphone disconnected");
    expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toEqual([]);
    saved.resolve({ ok: true });
    await vi.waitFor(() => fixture.expectClose(request, "voice-1"));
    await session.start();
    ctx.callbacks.onTalkEvent?.({ type: "session.closed" });
    expect(fixture.googleStop).toHaveBeenCalledOnce();
    expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(1);
    void session.stop();
  });

  it("closes a Gateway relay allocated after the session stops", async () => {
    const create = createDeferred<ReturnType<typeof fixture.createRelaySession>>();
    const request = fixture.strictRequest({
      "talk.client.create": () => create.promise,
      "talk.session.close": () => ({ ok: true }),
    });
    const session = fixture.sessionFor(request);

    const starting = session.start();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "talk.client.create",
        expect.anything(),
        fixture.requestTimeoutOptions,
      ),
    );
    void session.stop();
    create.resolve(fixture.createRelaySession("openai", "relay-stale"));
    await starting;

    fixture.expectRequest(request, "talk.session.close", { sessionId: "relay-stale" });
    expect(fixture.relayInstances).toHaveLength(0);
  });

  it("closes a superseded client-owned allocation without replacing the active call", async () => {
    const creates: Array<ReturnType<typeof createDeferred<unknown>>> = [];
    const request = fixture.strictRequest({
      "talk.client.create": () => {
        const create = createDeferred<unknown>();
        creates.push(create);
        return create.promise;
      },
      "talk.client.close": () => ({ ok: true }),
    });
    const client = { request } as never;
    const session = new RealtimeTalkSession(client, "main");

    const firstStart = session.start();
    await vi.waitFor(() => expect(creates).toHaveLength(1));
    void session.stop();
    const secondStart = session.start();
    await vi.waitFor(() => expect(creates).toHaveLength(2));
    creates[1]!.resolve(fixture.createWebRtcSession("voice-current"));
    await secondStart;
    const blocked = new RealtimeTalkSession(client, "main");
    await expect(blocked.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );
    expect(creates).toHaveLength(2);
    creates[0]!.resolve(fixture.createWebRtcSession("voice-stale"));
    await firstStart;

    await vi.waitFor(() => fixture.expectClose(request, "voice-stale"));
    expect(fixture.webRtcInstances).toHaveLength(1);
    expect(fixture.webRtcStart).toHaveBeenCalledTimes(1);
    void session.stop();
  });

  it("strips browser capabilities and hides camera when falling back to Gateway relay", async () => {
    const request = fixture.strictRequest({
      "talk.catalog": () => fixture.videoCatalog(true),
      "talk.client.create": () => {
        throw new Error("browser session unavailable");
      },
      "talk.config": () => ({ config: { talk: { realtime: { transport: "gateway-relay" } } } }),
      "talk.session.create": () => fixture.createRelaySession("openai"),
    });
    const onVideoCapability = vi.fn();
    const session = fixture.sessionFor(request, { onVideoCapability });

    await session.start();

    fixture.expectRequest(request, "talk.client.create", fixture.cameraParams, 2);
    fixture.expectRequest(request, "talk.session.create", fixture.relayParams, 4);
    expect(onVideoCapability).toHaveBeenCalledOnce();
    expect(onVideoCapability).toHaveBeenCalledWith(false);
    expect(fixture.relayInstances).toHaveLength(1);
  });

  it("passes voice-change options and camera choice to client-owned realtime session creation", async () => {
    const request = vi.fn(async () => fixture.createWebRtcSession());
    const session = fixture.sessionFor(
      request,
      {},
      {
        voice: "marin",
        voiceChangeId: "voice-change-1",
        transport: "webrtc",
      },
      { inputDeviceId: "usb-mic", videoDeviceId: "desk-camera" },
    );

    await session.start();

    fixture.expectRequest(request, "talk.client.create", {
      ...fixture.clientParams,
      voice: "marin",
      voiceChangeId: "voice-change-1",
      transport: "webrtc",
    });
    expect(fixture.transportContext(fixture.webRtcInstances[0])).toMatchObject({
      videoDeviceId: "desk-camera",
    });
  });

  it.each([false, true])(
    "negotiates camera capability without enabling it (supported: %s)",
    async (supported) => {
      const request = fixture.strictRequest({
        "talk.catalog": () => fixture.videoCatalog(supported),
        "talk.client.create": () => fixture.createWebRtcSession(),
        "talk.client.close": () => ({ ok: true }),
      });
      const onVideoCapability = vi.fn();
      const session = fixture.sessionFor(request, { onVideoCapability });

      await session.start();

      fixture.expectRequest(request, "talk.catalog", { sessionKey: "main" }, 1);
      fixture.expectRequest(
        request,
        "talk.client.create",
        supported ? fixture.cameraParams : fixture.clientParams,
        2,
      );
      expect(onVideoCapability).toHaveBeenCalledWith(supported);
      expect(fixture.transportContext(fixture.webRtcInstances[0])).toEqual(
        expect.not.objectContaining({ videoEnabled: expect.anything() }),
      );

      if (!supported) {
        void session.stop();
        return;
      }
      await session.setVideoEnabled(true);
      expect(fixture.webRtcSetVideoEnabled).toHaveBeenCalledWith(true);

      await switchActiveRealtimeTalkCameras("back-camera");
      expect(fixture.webRtcSwitchCamera).toHaveBeenCalledWith("back-camera");
      fixture.webRtcSwitchCamera.mockClear();
      await session.switchCamera("back-camera");
      expect(fixture.webRtcSwitchCamera).toHaveBeenCalledWith("back-camera");
      void session.stop();
    },
  );

  it("tracks a pending camera enable without retaining a stopped session", async () => {
    const enable = createDeferred<undefined>();
    fixture.webRtcSetVideoEnabled.mockImplementationOnce(() => enable.promise);
    const request = fixture.videoRequest("voice-pending-camera");
    const session = fixture.sessionFor(request, { onVideoCapability: vi.fn() });

    await session.start();
    const enabling = session.setVideoEnabled(true);
    await switchActiveRealtimeTalkCameras("back-camera");
    expect(fixture.webRtcSwitchCamera).toHaveBeenCalledOnce();
    expect(fixture.webRtcSwitchCamera).toHaveBeenCalledWith("back-camera");

    void session.stop();
    enable.resolve(undefined);
    await enabling;
    await switchActiveRealtimeTalkCameras("desk-camera");
    expect(fixture.webRtcSwitchCamera).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "config selects a client transport",
      readConfig: async () => ({
        config: { talk: { realtime: { transport: "provider-websocket" } } },
      }),
    },
    {
      name: "config cannot be read",
      readConfig: async () => {
        throw new Error("config unavailable");
      },
    },
    { name: "config payload is missing", readConfig: async () => ({}) },
  ])("does not fall back when $name", async ({ readConfig }) => {
    const clientError = new Error("browser session unavailable");
    const request = fixture.strictRequest({
      "talk.client.create": () => {
        throw clientError;
      },
      "talk.config": readConfig,
    });
    const session = fixture.sessionFor(request);

    await expect(session.start()).rejects.toBe(clientError);

    expect(request.mock.calls).toEqual([
      ["talk.client.create", fixture.clientParams, fixture.requestTimeoutOptions],
      ["talk.config", {}, fixture.requestTimeoutOptions],
    ]);
    expect(fixture.relayInstances).toHaveLength(0);
  });

  it.each([
    { name: "Gateway relay", config: { talk: { realtime: { transport: "gateway-relay" } } } },
    { name: "Auto", config: {} },
  ])("falls back to Gateway relay when config resolves $name", async ({ config }) => {
    const request = fixture.strictRequest({
      "talk.client.create": () => {
        throw new Error("browser session unavailable");
      },
      "talk.config": () => ({ config }),
      "talk.session.create": () => fixture.createRelaySession(),
    });
    const session = fixture.sessionFor(request);

    await session.start();

    fixture.expectRequest(request, "talk.session.create", fixture.relayParams, 3);
    expect(fixture.relayInstances).toHaveLength(1);
    expect(fixture.relayStart).toHaveBeenCalledTimes(1);
  });

  it.each([
    { pendingMethod: "talk.client.create", restart: false },
    { pendingMethod: "talk.client.create", restart: true },
    { pendingMethod: "talk.config", restart: false },
    { pendingMethod: "talk.config", restart: true },
  ])(
    "does not allocate a fallback after Stop during $pendingMethod (restart: $restart)",
    async ({ pendingMethod, restart }) => {
      const pending = createDeferred<unknown>();
      const clientError = new Error("browser session unavailable");
      let creates = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.create") {
          creates += 1;
          if (creates === 1) {
            if (pendingMethod === method) {
              return await pending.promise;
            }
            throw clientError;
          }
          return fixture.createWebRtcSession("replacement", "test-session");
        }
        if (method === "talk.config") {
          return await pending.promise;
        }
        if (method === "talk.session.create") {
          return {
            provider: "example",
            transport: "gateway-relay",
            relaySessionId: "unexpected-relay",
          };
        }
        return { ok: true };
      });
      const session = new RealtimeTalkSession({ request } as never, "main");
      const starting = session.start().then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(fixture.called(request, pendingMethod)).toBe(true));
      void session.stop();
      if (restart) {
        await session.start();
      }
      if (pendingMethod === "talk.client.create") {
        pending.reject(clientError);
      } else {
        pending.resolve({ config: { talk: { realtime: { transport: "gateway-relay" } } } });
      }
      const error = await starting;

      expect(fixture.called(request, "talk.session.create")).toBe(false);
      expect(error).toBe(clientError);
      expect(session.getVoiceSessionId()).toBe(restart ? "replacement" : undefined);
      void session.stop();
    },
  );
});

describe("RealtimeTalkSession lifecycle", () => {
  it("retires a restarted call before allocation and drains its accepted transcript after startup fails", async () => {
    const saved = createDeferred();
    let creates = 0;
    let oldStopsAtAllocation = 0;
    const request = vi.fn(async (method: string, params?: { voiceSessionId?: string }) => {
      if (method === "talk.client.create") {
        creates += 1;
        if (creates === 2) {
          oldStopsAtAllocation = fixture.webRtcInstances[0]!.stop.mock.calls.length;
        }
        return fixture.createWebRtcSession(
          params?.voiceSessionId ?? `voice-restart-${creates}`,
          "fixture-secret",
        );
      }
      if (method === "talk.client.transcript") {
        await saved.promise;
      }
      return { ok: true };
    });
    const session = fixture.voiceSession(request);
    try {
      await session.start();
      const previous = fixture.transportContext(fixture.webRtcInstances[0]);
      fixture.publish(previous, "accepted before restart");
      fixture.webRtcStart.mockRejectedValueOnce(new Error("replacement startup failed"));

      await expect(session.start()).rejects.toThrow("replacement startup failed");

      expect(oldStopsAtAllocation).toBe(1);
      expect(fixture.webRtcInstances[0]!.stop).toHaveBeenCalledOnce();
      expect(fixture.webRtcInstances[1]!.stop).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(fixture.closeIds(request)).toEqual(["voice-restart-2"]));
      fixture.publish(previous, "stale after restart");
      saved.resolve();
      await vi.waitFor(() =>
        expect(fixture.closeIds(request)).toEqual(["voice-restart-2", "voice-restart-1"]),
      );
      expect(fixture.calls(request, "talk.client.transcript")).toHaveLength(1);
    } finally {
      saved.resolve();
      void session.stop();
    }
  });

  it("retries finalized transcript writes in order", async () => {
    vi.useFakeTimers();
    const transcriptEntryIds: string[] = [];
    let firstAttempt = true;
    const request = fixture.voiceRequest(
      () => fixture.createWebRtcSession("voice-queue"),
      transcriptEntryIds,
      (method, params) => {
        if (method === "talk.client.transcript" && params?.entryId === "1" && firstAttempt) {
          firstAttempt = false;
          throw new Error("temporary failure");
        }
      },
    );
    const { session, context } = await fixture.start(request);
    fixture.publish(context, "first");
    fixture.publish(context, "second", "assistant");

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(transcriptEntryIds).toEqual(["1", "1", "2"]));
    void session.stop();
    await vi.runAllTimersAsync();
  });

  it("starts fresh transcript ownership when restarting the same browser session", async () => {
    let creates = 0;
    const entries: Array<{ voiceSessionId?: string; entryId?: string }> = [];
    const request = vi.fn(
      async (method: string, params?: { voiceSessionId?: string; entryId?: string }) => {
        if (method === "talk.client.create") {
          return fixture.createWebRtcSession(`voice-restart-${++creates}`, "fixture-secret");
        }
        if (method === "talk.client.transcript") {
          entries.push({ voiceSessionId: params?.voiceSessionId, entryId: params?.entryId });
        }
        return { ok: true };
      },
    );
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    const first = fixture.transportContext(fixture.webRtcInstances[0]);
    fixture.publish(first, "first call");
    await first.flushTranscriptWrites?.();
    await session.start();
    const second = fixture.transportContext(fixture.webRtcInstances[1]);
    fixture.publish(second, "second call", "assistant");
    await second.flushTranscriptWrites?.();
    expect(entries).toEqual([
      { voiceSessionId: "voice-restart-1", entryId: "1" },
      { voiceSessionId: "voice-restart-2", entryId: "1" },
    ]);
    for (const [, params] of fixture.calls(request, "talk.client.create")) {
      expect(params).not.toHaveProperty("voiceSessionId");
    }
    expect(fixture.webRtcInstances[0]!.stop).toHaveBeenCalledOnce();
    expect(fixture.webRtcInstances[1]!.stop).not.toHaveBeenCalled();
    void session.stop();
    await vi.waitFor(() => expect(fixture.calls(request, "talk.client.close")).toHaveLength(2));
  });

  it("closes both calls when a restart cancels during transport startup", async () => {
    const request = fixture.sequenceRequest("voice-cancelled");
    const { session, context: previous } = await fixture.start(request);
    fixture.webRtcStart.mockResolvedValueOnce("cancelled");
    await session.start();
    expect(fixture.webRtcInstances[0]!.stop).toHaveBeenCalledOnce();
    expect(fixture.webRtcInstances[1]!.stop).toHaveBeenCalledWith({ emitClosed: false });
    fixture.publish(previous, "stale call");
    await vi.waitFor(() => expect(fixture.calls(request, "talk.client.close")).toHaveLength(2));
    expect(request.mock.calls.some(([method]) => method === "talk.client.transcript")).toBe(false);
    void session.stop();
  });

  it.each([false, true])(
    "retires relays when activation throws (concurrent stop: %s)",
    async (stop) => {
      const request = fixture.voiceRequest(() =>
        fixture.createRelaySession("openai", "relay-activation-stop"),
      );
      const session = fixture.voiceSession(request);
      await session.start();
      fixture.relayActivate.mockImplementationOnce(() => {
        if (stop) {
          void session.stop();
        }
        throw new Error("activation failed");
      });

      await expect(session.start()).rejects.toThrow("activation failed");

      expect(fixture.relayInstances[0]!.stop).toHaveBeenCalledOnce();
      if (stop) {
        expect(fixture.relayInstances[0]!.stop).toHaveBeenCalledWith({ disposition: "detach" });
      }
      expect(fixture.relayInstances[1]!.stop).toHaveBeenCalledOnce();
      void session.stop();
      expect(fixture.relayInstances[0]!.stop).toHaveBeenCalledOnce();
      expect(fixture.relayInstances[1]!.stop).toHaveBeenCalledOnce();
    },
  );

  it("ignores transcripts from a superseded pending replacement", async () => {
    const firstReplacementStart = createDeferred<"ready">();
    const transcriptEntryIds: string[] = [];
    const request = fixture.sequenceRequest("voice-overlapping", transcriptEntryIds);
    const session = fixture.voiceSession(request);
    await session.start();
    fixture.webRtcStart.mockImplementationOnce(async () => await firstReplacementStart.promise);

    const firstReplacement = session.start();
    await vi.waitFor(() => expect(fixture.webRtcInstances).toHaveLength(2));
    await session.start();

    const supersededContext = fixture.transportContext(fixture.webRtcInstances[1]);
    const activeContext = fixture.transportContext(fixture.webRtcInstances[2]);
    fixture.publish(supersededContext, "stale");
    fixture.publish(activeContext, "active");
    await activeContext.flushTranscriptWrites?.();
    expect(transcriptEntryIds).toEqual(["1"]);
    expect(fixture.webRtcInstances[1]!.stop).toHaveBeenCalledWith({
      disposition: "detach",
      emitClosed: false,
    });

    firstReplacementStart.resolve("ready");
    await firstReplacement;
    void session.stop();
  });

  it("does not supersede an admitted restart when its predecessor is still draining", async () => {
    const replacementCreate = createDeferred<ReturnType<typeof fixture.createWebRtcSession>>();
    const predecessorClose = createDeferred();
    let creates = 0;
    const transcriptEntryIds: string[] = [];
    const request = vi.fn(
      async (method: string, params?: { voiceSessionId?: string; entryId?: string }) => {
        if (method === "talk.client.create") {
          if (++creates === 2) {
            return await replacementCreate.promise;
          }
          return fixture.createWebRtcSession("voice-admission-1", "fixture-secret");
        }
        if (method === "talk.client.close" && params?.voiceSessionId === "voice-admission-1") {
          await predecessorClose.promise;
        }
        if (method === "talk.client.transcript") {
          transcriptEntryIds.push(String(params?.entryId));
        }
        return { ok: true };
      },
    );
    const session = fixture.voiceSession(request);
    let replacement: Promise<void> | undefined;
    try {
      await session.start();
      replacement = session.start();
      await vi.waitFor(() => expect(creates).toBe(2));
      await expect(session.start()).rejects.toThrow(
        "Too many active or closing realtime Talk voice sessions",
      );
      expect(creates).toBe(2);
      replacementCreate.resolve(fixture.createWebRtcSession("voice-admission-2", "fixture-secret"));
      await replacement;
      expect(fixture.webRtcInstances).toHaveLength(2);
      expect(fixture.webRtcInstances[1]!.stop).not.toHaveBeenCalled();
      const active = fixture.transportContext(fixture.webRtcInstances[1]);
      fixture.publish(active, "still active");
      await active.flushTranscriptWrites?.();
      expect(transcriptEntryIds).toEqual(["1"]);
    } finally {
      predecessorClose.resolve();
      replacementCreate.resolve(fixture.createWebRtcSession("voice-admission-2", "fixture-secret"));
      void session.stop();
      await replacement;
    }
  });

  it("releases newly allocated owners after transport startup failures", async () => {
    const request = fixture.sequenceRequest("voice-start");
    const client = { request } as never;
    fixture.webRtcStart
      .mockRejectedValueOnce(new Error("first startup failed"))
      .mockRejectedValueOnce(new Error("second startup failed"));

    const first = new RealtimeTalkSession(client, "agent:main:main");
    await expect(first.start()).rejects.toThrow("first startup failed");
    await vi.waitFor(() => expect(fixture.calls(request, "talk.client.close")).toHaveLength(1));

    const second = new RealtimeTalkSession(client, "agent:main:main");
    await expect(second.start()).rejects.toThrow("second startup failed");
    await vi.waitFor(() => expect(fixture.calls(request, "talk.client.close")).toHaveLength(2));

    const recovered = new RealtimeTalkSession(client, "agent:main:main");
    await recovered.start();
    void recovered.stop();
  });

  it("does not restore a failed replacement after concurrent stop", async () => {
    const replacementStart = createDeferred<"ready">();
    const transcriptEntryIds: string[] = [];
    const request = fixture.sequenceRequest("voice-concurrent-stop", transcriptEntryIds);
    const client = { request } as never;
    const session = new RealtimeTalkSession(client, "agent:main:main");
    await session.start();
    const existingContext = fixture.transportContext(fixture.webRtcInstances[0]);
    fixture.webRtcStart.mockImplementationOnce(async () => await replacementStart.promise);

    fixture.publish(existingContext, "before restart");
    await existingContext.flushTranscriptWrites?.();
    const replacing = session.start();
    await vi.waitFor(() => expect(fixture.webRtcInstances).toHaveLength(2));
    fixture.publish(existingContext, "during restart");
    expect(transcriptEntryIds).toEqual(["1"]);

    void session.stop();
    replacementStart.reject(new Error("replacement failed after stop"));
    await expect(replacing).rejects.toThrow("replacement failed after stop");

    fixture.publish(existingContext, "too late");
    await Promise.resolve();
    expect(transcriptEntryIds).toEqual(["1"]);
    expect(fixture.webRtcInstances[0]!.stop).toHaveBeenCalledOnce();
    expect(fixture.webRtcInstances[0]!.stop).toHaveBeenCalledWith({ disposition: "detach" });
    expect(fixture.webRtcInstances[1]!.stop).toHaveBeenCalledWith({ emitClosed: false });
    await vi.waitFor(() => expect(fixture.calls(request, "talk.client.close")).toHaveLength(2));

    const recovered = new RealtimeTalkSession(client, "agent:main:main");
    await recovered.start();
    void recovered.stop();
  });

  it("retries logical voice-session close after transient failures", async () => {
    vi.useFakeTimers();
    let closeAttempts = 0;
    const request = fixture.voiceRequest(
      () => fixture.createWebRtcSession("voice-close-retry"),
      undefined,
      (method) => {
        if (method === "talk.client.close" && ++closeAttempts < 3) {
          throw new Error("temporary close failure");
        }
      },
    );
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();

    void session.stop();
    await vi.runAllTimersAsync();

    expect(closeAttempts).toBe(3);
  });

  it("bounds active and draining client voice owners across session objects", async () => {
    let createCount = 0;
    const closes: Array<ReturnType<typeof createDeferred<void>>> = [];
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return fixture.createWebRtcSession(`voice-${createCount}`);
      }
      if (method === "talk.client.close") {
        const close = createDeferred();
        closes.push(close);
        await close.promise;
      }
      return { ok: true };
    });
    const client = { request } as never;
    const first = new RealtimeTalkSession(client, "agent:main:main");
    const second = new RealtimeTalkSession(client, "agent:main:main");
    const third = new RealtimeTalkSession(client, "agent:main:main");

    await first.start();
    await second.start();
    await expect(first.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );
    expect(fixture.webRtcInstances[0]!.stop).not.toHaveBeenCalled();
    expect(fixture.webRtcInstances[1]!.stop).not.toHaveBeenCalled();
    expect(createCount).toBe(2);
    void first.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(1));
    void second.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(2));

    await expect(third.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );
    expect(createCount).toBe(2);

    closes[0]?.resolve();
    await vi.waitFor(async () => {
      await third.start();
      expect(createCount).toBe(3);
    });

    void third.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(3));
    closes[1]?.resolve();
    closes[2]?.resolve();
  });

  it("bounds stalled detached owners across browser session keys", async () => {
    vi.useFakeTimers();
    let createCount = 0;
    const closeSignals: AbortSignal[] = [];
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "talk.client.create") {
          createCount += 1;
          return fixture.createWebRtcSession(`voice-${createCount}`);
        }
        if (method === "talk.client.close") {
          const signal = options?.signal;
          if (!signal) {
            throw new Error("expected close abort signal");
          }
          closeSignals.push(signal);
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return { ok: true };
      },
    );
    const client = { request } as never;
    const draining = Array.from(
      { length: 16 },
      (_, index) => new RealtimeTalkSession(client, `agent:main:session-${index}`),
    );

    for (const session of draining) {
      await session.start();
      void session.stop();
      await Promise.resolve();
    }
    expect(closeSignals).toHaveLength(16);

    const recovered = new RealtimeTalkSession(client, "agent:main:session-recovered");
    await expect(recovered.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );
    expect(createCount).toBe(16);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(closeSignals.every((signal) => !signal.aborted)).toBe(true);
    await expect(recovered.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(closeSignals.every((signal) => signal.aborted)).toBe(true);

    await recovered.start();
    expect(createCount).toBe(17);
    void recovered.stop();
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it("releases bounded startup owners after request deadlines", async () => {
    vi.useFakeTimers();
    let failCreate = true;
    const requestsStarted = createDeferred();
    let pendingCreates = 0;
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: { timeoutMs?: number }) => {
        if (method !== "talk.client.create") {
          return { ok: true };
        }
        if (!failCreate) {
          return fixture.createWebRtcSession("voice-recovered");
        }
        await new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error("request timeout")), options?.timeoutMs);
          if (++pendingCreates === 2) {
            requestsStarted.resolve();
          }
        });
        return { ok: true };
      },
    );
    const client = { request } as never;
    const first = new RealtimeTalkSession(client, "agent:main:main", {}, { transport: "webrtc" });
    const second = new RealtimeTalkSession(client, "agent:main:main", {}, { transport: "webrtc" });
    const third = new RealtimeTalkSession(client, "agent:main:main", {}, { transport: "webrtc" });

    const startsSettled = Promise.allSettled([first.start(), second.start()]);
    await requestsStarted.promise;
    await expect(third.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );
    expect(fixture.calls(request, "talk.client.create")).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(30_000);
    const settled = await startsSettled;
    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);

    failCreate = false;
    await third.start();
    void third.stop();
  });

  it("drops a previous transport's delayed transcript and close event after stop and restart", async () => {
    const request = fixture.sequenceRequest("voice");
    const onTranscript = vi.fn();
    const onTalkEvent = vi.fn();
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
      onTranscript,
      onTalkEvent,
    });
    await session.start();
    const previousContext = fixture.transportContext(fixture.webRtcInstances[0]);

    void session.stop();
    await session.start();
    onTalkEvent.mockClear();
    fixture.publish(previousContext, "stale transcript");
    previousContext.callbacks.onTalkEvent?.({
      type: "session.closed",
    });
    await Promise.resolve();

    expect(onTranscript).not.toHaveBeenCalled();
    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(session.getVoiceSessionId()).toBe("voice-2");
    expect(request.mock.calls.some(([method]) => method === "talk.client.transcript")).toBe(false);
    void session.stop();
  });

  it("does not report Gateway relay transcripts through the client RPC", async () => {
    const request = fixture.voiceRequest(() => fixture.createRelaySession("openai", "relay-voice"));
    const session = fixture.voiceSession(request);
    await session.start();
    const context = fixture.transportContext(fixture.relayInstances[0]);
    expect(fixture.relayActivate).toHaveBeenCalledOnce();
    fixture.publish(context, "server owns this");
    await Promise.resolve();

    expect(request.mock.calls.some(([method]) => method === "talk.client.transcript")).toBe(false);
    void session.stop();
    await Promise.resolve();
    expect(request.mock.calls.some(([method]) => method === "talk.client.close")).toBe(false);
  });
});

it("does not admit normalized-empty finals into a stalled transcript queue", async () => {
  const firstTranscript = createDeferred();
  const transcriptEntryIds: string[] = [];
  const request = fixture.queueRequest("voice-empty-finals", async (method, params) => {
    if (method === "talk.client.transcript") {
      transcriptEntryIds.push(String(params?.entryId));
      if (params?.entryId === "1") {
        await firstTranscript.promise;
      }
    }
  });
  const onStatus = vi.fn();
  const onTranscript = vi.fn();
  const { session, context, handleTranscript } = await fixture.start(request, {
    onStatus,
    onTranscript,
  });

  handleTranscript({ role: "user", text: "first", final: true });
  for (let index = 0; index < 10_000; index += 1) {
    handleTranscript({ role: "assistant", text: "   ", final: true });
  }
  for (let index = 0; index < 40; index += 1) {
    handleTranscript({ role: "assistant", text: `queued-${index}`, final: true });
  }

  expect(transcriptEntryIds).toEqual(["1"]);
  expect(fixture.webRtcStop).not.toHaveBeenCalled();
  expect(onStatus.mock.calls.filter(([status]) => status === "error")).toHaveLength(0);
  expect(onTranscript).toHaveBeenCalledTimes(10_041);

  firstTranscript.resolve();
  await context.flushTranscriptWrites?.();

  expect(transcriptEntryIds).toEqual(Array.from({ length: 41 }, (_, index) => String(index + 1)));
  void session.stop();
});

it("stops once when stalled transcript persistence exceeds its bounded queue", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const firstTranscript = createDeferred();
  const transcriptEntryIds: string[] = [];
  let firstAttempt = true;
  const request = fixture.queueRequest("voice-overflow", async (method, params) => {
    if (method === "talk.client.transcript") {
      transcriptEntryIds.push(String(params?.entryId));
      if (params?.entryId === "1") {
        if (firstAttempt) {
          firstAttempt = false;
          await firstTranscript.promise;
        }
        throw new Error("still unavailable");
      }
    }
  });
  const onStatus = vi.fn();
  const { session, handleTranscript: onTranscript } = await fixture.start(request, { onStatus });
  for (let index = 0; index < 10_000; index += 1) {
    onTranscript({
      role: index % 2 === 0 ? "user" : "assistant",
      text: `  ${"x".repeat(9_000)}  `,
      final: true,
    });
  }

  expect(transcriptEntryIds).toEqual(["1"]);
  expect(fixture.webRtcStop).toHaveBeenCalledOnce();
  expect(onStatus.mock.calls.filter(([status]) => status === "error")).toHaveLength(1);
  expect(warn).toHaveBeenCalledOnce();
  expect(fixture.calls(request, "talk.client.close")).toHaveLength(0);

  firstTranscript.resolve();
  await vi.advanceTimersByTimeAsync(2_500);
  await vi.runAllTimersAsync();

  expect(transcriptEntryIds).toEqual([
    "1",
    "1",
    "1",
    ...Array.from({ length: 40 }, (_, index) => String(index + 2)),
  ]);
  expect(
    fixture
      .calls(request, "talk.client.transcript")
      .every(([, params]) => String(params?.text).length === 8_000),
  ).toBe(true);
  expect(fixture.calls(request, "talk.client.close")).toHaveLength(1);
  expect(onStatus.mock.calls.filter(([status]) => status === "error")).toHaveLength(1);
  expect(warn).toHaveBeenCalledTimes(2);

  onTranscript({ role: "user", text: "too late", final: true });
  void session.stop();
  await Promise.resolve();
  expect(transcriptEntryIds).toHaveLength(43);
  expect(fixture.webRtcStop).toHaveBeenCalledOnce();
});

it("aborts a detached transcript drain before releasing its client owner", async () => {
  vi.useFakeTimers();
  const transcriptSignals: AbortSignal[] = [];
  const closeSignals: AbortSignal[] = [];
  const request = fixture.queueRequest("voice-drain-timeout", async (method, _params, options) => {
    if (method !== "talk.client.transcript" && method !== "talk.client.close") {
      return;
    }
    const signal = options?.signal;
    if (!signal) {
      throw new Error(`expected ${method} abort signal`);
    }
    (method === "talk.client.transcript" ? transcriptSignals : closeSignals).push(signal);
    if (method === "talk.client.transcript") {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
  });
  const onStatus = vi.fn();
  const { session, handleTranscript } = await fixture.start(request, { onStatus });
  handleTranscript({ role: "user", text: "stalled", final: true });
  for (let index = 0; index < 40; index += 1) {
    handleTranscript({ role: "assistant", text: `queued-${index}`, final: true });
  }
  void session.stop();
  expect(transcriptSignals).toEqual([expect.objectContaining({ aborted: false })]);
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.runAllTimersAsync();

  expect(transcriptSignals[0]?.aborted).toBe(true);
  expect(fixture.calls(request, "talk.client.transcript")).toHaveLength(1);
  expect(request).toHaveBeenCalledWith(
    "talk.client.close",
    { sessionKey: "agent:main:main", voiceSessionId: "voice-drain-timeout" },
    { signal: closeSignals[0], timeoutMs: 30_000 },
  );
  expect(closeSignals[0]).not.toBe(transcriptSignals[0]);
  expect(closeSignals[0]?.aborted).toBe(false);
  expect(onStatus.mock.calls.filter(([status]) => status === "error")).toHaveLength(0);
});
