import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createNodeMeetingRealtimeAudioTransport } from "./realtime-node-audio-transport.js";

function createTransport(
  invoke: ReturnType<typeof vi.fn>,
  options: { outputGenerationSupported?: boolean } = {},
) {
  const transport = createNodeMeetingRealtimeAudioTransport({
    runtime: { nodes: { invoke } } as never,
    nodeId: "node-1",
    bridgeId: "bridge-1",
    logger: { warn: vi.fn(), debug: vi.fn() } as never,
    commandName: "meeting.chrome",
    logScope: "[meeting]",
    logPrefix: "node",
  });
  Reflect.set(
    transport,
    Symbol.for("openclaw.internal.meeting-node-output-generation.v1"),
    options.outputGenerationSupported === true,
  );
  return transport;
}

describe("node meeting realtime audio transport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects malformed input and continues with the next valid chunk", async () => {
    vi.useFakeTimers();
    let pullCount = 0;
    let releaseIdlePull: (() => void) | undefined;
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      if (params.action !== "pullAudio") {
        releaseIdlePull?.();
        return { ok: true };
      }
      pullCount += 1;
      if (pullCount === 1) {
        return { base64: "not-base64!" };
      }
      if (pullCount === 2) {
        return { base64: Buffer.from([5, 4, 3]).toString("base64") };
      }
      await new Promise<void>((resolve) => {
        releaseIdlePull = resolve;
      });
      return {};
    });
    const transport = createTransport(invoke);
    const onAudio = vi.fn();

    transport.startInput(onAudio);
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => {
      expect(onAudio).toHaveBeenCalledWith(Buffer.from([5, 4, 3]));
    });
    expect(transport.getHealth?.()).toEqual({
      consecutiveInputErrors: 0,
      lastInputError: undefined,
      lastOutputLoopbackAt: undefined,
      lastOutputLoopbackCorrelation: undefined,
      lastOutputLoopbackPeak: undefined,
      lastOutputLoopbackRms: undefined,
      outputGeneration: 0,
      outputLoopbackSignalBytes: 0,
      verifiedOutputGeneration: undefined,
    });

    await transport.stop();
  });

  it("signals fatal after five malformed input chunks", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) =>
      params.action === "pullAudio" ? { base64: "not-base64!" } : { ok: true },
    );
    const transport = createTransport(invoke);
    const onFatal = vi.fn();
    const onAudio = vi.fn();
    transport.onFatal(onFatal);

    transport.startInput(onAudio);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(onFatal).toHaveBeenCalledTimes(1);
    });
    expect(onAudio).not.toHaveBeenCalled();
    expect(transport.getHealth?.()).toEqual({
      consecutiveInputErrors: 5,
      lastInputError: "pullAudio base64 must be a valid audio payload",
      lastOutputLoopbackAt: undefined,
      lastOutputLoopbackCorrelation: undefined,
      lastOutputLoopbackPeak: undefined,
      lastOutputLoopbackRms: undefined,
      outputGeneration: 0,
      outputLoopbackSignalBytes: 0,
      verifiedOutputGeneration: undefined,
    });

    await transport.stop();
  });

  it("cannot verify stopped output from a pending input pull", async () => {
    const pendingPull = createDeferredCore<{ base64: string }>();
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) =>
      params.action === "pullAudio" ? pendingPull.promise : {},
    );
    const transport = createTransport(invoke);
    const output = Buffer.alloc(80 * 240 * 2);
    for (let sample = 0; sample < output.byteLength / 2; sample += 1) {
      const amplitude = 400 + ((Math.floor(sample / 240) * 7919) % 12_000);
      output.writeInt16LE(sample % 2 === 0 ? amplitude : -amplitude, sample * 2);
    }
    await transport.writeOutput(output);
    const health = transport.getHealth?.();
    const onAudio = vi.fn();
    transport.startInput(onAudio);
    await transport.stop();
    pendingPull.resolve({ base64: output.toString("base64") });
    await setImmediate();

    expect(transport.getHealth?.()).toEqual(health);
    expect(onAudio).not.toHaveBeenCalled();
  });

  it("fences output writes across clear and stop", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const transport = createTransport(invoke, { outputGenerationSupported: true });

    await transport.writeOutput(Buffer.from([1, 2, 3]));
    await transport.clearOutput();
    await transport.writeOutput(Buffer.from([4, 5, 6]));

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        params: expect.objectContaining({
          action: "pushAudio",
          outputGeneration: 0,
        }),
      }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: {
          action: "clearAudio",
          bridgeId: "bridge-1",
          outputGeneration: 1,
        },
      }),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        params: expect.objectContaining({
          action: "pushAudio",
          outputGeneration: 1,
        }),
      }),
    );

    await transport.stop();
    const invokeCountAfterStop = invoke.mock.calls.length;
    await transport.writeOutput(Buffer.from([7, 8, 9]));
    await transport.clearOutput();
    expect(invoke).toHaveBeenCalledTimes(invokeCountAfterStop);
  });

  it("serializes output commands for legacy node hosts", async () => {
    const pushStarted = createDeferredCore();
    let releasePush: (() => void) | undefined;
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      if (params.action === "pushAudio") {
        await new Promise<void>((resolve) => {
          releasePush = resolve;
          pushStarted.resolve();
        });
      }
      return { ok: true };
    });
    const transport = createTransport(invoke);

    const pushing = transport.writeOutput(Buffer.from([1, 2, 3]));
    const clearing = transport.clearOutput();
    await withTestTimeout(pushStarted.promise, 1_000, "legacy output push did not start");
    // Give an incorrectly unblocked clear a turn while pushAudio is still blocked.
    await setImmediate();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        params: {
          action: "pushAudio",
          bridgeId: "bridge-1",
          base64: Buffer.from([1, 2, 3]).toString("base64"),
        },
      }),
    );

    releasePush?.();
    await Promise.all([pushing, clearing]);
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: {
          action: "clearAudio",
          bridgeId: "bridge-1",
        },
      }),
    );

    await transport.stop();
  });

  it("clears immediately when the node host supports output generations", async () => {
    let releasePush: (() => void) | undefined;
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      if (params.action === "pushAudio") {
        await new Promise<void>((resolve) => {
          releasePush = resolve;
        });
      }
      return { ok: true };
    });
    const transport = createTransport(invoke, { outputGenerationSupported: true });

    const pushing = transport.writeOutput(Buffer.from([1, 2, 3]));
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(1);
    });
    await transport.clearOutput();
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: {
          action: "clearAudio",
          bridgeId: "bridge-1",
          outputGeneration: 1,
        },
      }),
    );

    releasePush?.();
    await pushing;
    await transport.stop();
  });

  it("stops a legacy node host without waiting for blocked output", async () => {
    const pushStarted = createDeferredCore();
    let releasePush: (() => void) | undefined;
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      if (params.action === "pushAudio") {
        await new Promise<void>((resolve) => {
          releasePush = resolve;
          pushStarted.resolve();
        });
      } else if (params.action === "stop") {
        releasePush?.();
      }
      return { ok: true };
    });
    const transport = createTransport(invoke);

    const pushing = transport.writeOutput(Buffer.from([1, 2, 3]));
    const clearing = transport.clearOutput();
    await withTestTimeout(pushStarted.promise, 1_000, "legacy output push did not start");
    // Give an incorrectly unblocked clear a turn while pushAudio is still blocked.
    await setImmediate();
    expect(invoke).toHaveBeenCalledTimes(1);
    await transport.stop();
    await Promise.all([pushing, clearing]);

    expect(invoke.mock.calls.map(([call]) => call.params.action)).toEqual(["pushAudio", "stop"]);
  });
  it("keeps bridge commands reachable after the joining plugin call has responded", async () => {
    // Stands in for the Gateway request scope whose client authority closes once the
    // join method responds; node invokes still inside it are rejected.
    const joinRequest = new AsyncLocalStorage<{ responded: boolean }>();
    const pulls: ReturnType<typeof createDeferredCore<Record<string, unknown>>>[] = [];
    const invoke = vi.fn(async ({ params }: { params: { action: string } }) => {
      if (joinRequest.getStore()?.responded) {
        throw new Error("Gateway client authority closed before dispatching node.invoke.");
      }
      if (params.action !== "pullAudio") {
        return { ok: true };
      }
      const pending = createDeferredCore<Record<string, unknown>>();
      pulls.push(pending);
      return await pending.promise;
    });
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "meeting-owner" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { registry, record });
    const request = { responded: false };
    const onAudio = vi.fn();
    const onFatal = vi.fn();
    const transport = joinRequest.run(request, () =>
      instance.run(() => {
        const created = createTransport(invoke);
        created.onFatal(onFatal);
        created.startInput(onAudio);
        return created;
      }),
    );
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    pulls.shift()?.resolve({ base64: Buffer.from([1, 2]).toString("base64") });
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    request.responded = true;
    pulls.shift()?.resolve({ base64: Buffer.from([3, 4]).toString("base64") });
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    await joinRequest.run(request, () => transport.writeOutput(Buffer.from([5, 6])));
    expect(onAudio.mock.calls).toEqual([[Buffer.from([1, 2])], [Buffer.from([3, 4])]]);
    expect(onFatal).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ action: "pushAudio" }) }),
    );

    await transport.stop();
    pulls.shift()?.resolve({});
  });
});
