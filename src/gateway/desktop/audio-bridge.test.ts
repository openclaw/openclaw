import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ProcessSupervisor, SpawnInput } from "../../process/supervisor/types.js";
import { createManagedLinuxAudio, type DesktopAudioSource } from "./managed-linux-audio.js";

const peers = vi.hoisted(() => ({ next: undefined as unknown }));
vi.mock("../../../packages/gateway-client/src/websocket.js", () => ({
  WebSocket: { OPEN: 1 },
  WebSocketServer: class {
    handleUpgrade(
      _req: unknown,
      _socket: unknown,
      _head: unknown,
      callback: (ws: unknown) => void,
    ) {
      callback(peers.next);
    }
  },
}));
vi.mock("../websocket-keepalive.js", () => ({ startWebSocketKeepalive: () => () => {} }));
import { handleDesktopAudioUpgrade, mintDesktopAudioObserver } from "./audio-bridge.js";

class Peer extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<string | Buffer> = [];
  closed: Array<[number, string]> = [];
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close(code: number, reason: string) {
    this.closed.push([code, reason]);
    this.readyState = 3;
  }
  command(action: string) {
    this.emit("message", Buffer.from(JSON.stringify({ action })), false);
  }
}
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.useRealTimers();
});
const flush = async () => {
  for (let n = 0; n < 12; n++) {
    await Promise.resolve();
  }
};

function fixture(
  requester?: { isCurrent(): boolean; signal?: AbortSignal },
  source?: DesktopAudioSource,
) {
  const captures: Array<{
    stream: PassThrough;
    stop: ReturnType<typeof vi.fn>;
    signal: AbortSignal;
  }> = [];
  const start = vi.fn(async (signal: AbortSignal) => {
    const stream = new PassThrough();
    const stop = vi.fn(async () => {
      stream.destroy();
    });
    const capture = { stream, stop, signal };
    captures.push(capture);
    return capture;
  });
  const observation = mintDesktopAudioObserver({ source: source ?? { start }, requester });
  cleanups.push(observation.close);
  const peer = new Peer();
  const attach = (path = observation.descriptor.wsPath) => {
    peers.next = peer;
    const transport = new PassThrough();
    handleDesktopAudioUpgrade({ url: path } as IncomingMessage, transport, Buffer.alloc(0));
    return transport;
  };
  const firstCapture = () => {
    const capture = captures[0];
    if (!capture) {
      throw new Error("Expected an admitted capture");
    }
    return capture;
  };
  return { observation, peer, start, captures, firstCapture, attach };
}

describe("screen-owned desktop audio", () => {
  it("does not capture on attach or before screen authentication, then delivers remote PCM", async () => {
    const f = fixture();
    f.attach();
    await flush();
    expect(f.start).not.toHaveBeenCalled();
    f.peer.command("start");
    await flush();
    expect(f.start).not.toHaveBeenCalled();
    f.observation.activate();
    await flush();
    expect(f.start).toHaveBeenCalledTimes(1);
    const pcm = Buffer.from([0, 1, 0, 2]);
    f.firstCapture().stream.write(pcm);
    expect(f.peer.sent).toContainEqual(pcm);
    f.observation.close();
    await flush();
    expect(f.firstCapture().signal.aborted).toBe(true);
    expect(f.firstCapture().stop).toHaveBeenCalledTimes(1);
  });

  it("mutes immediately and serializes re-enable without overlapping recorders", async () => {
    const f = fixture();
    f.attach();
    f.observation.activate();
    f.peer.command("start");
    await flush();
    f.peer.command("start");
    await flush();
    expect(f.start).toHaveBeenCalledTimes(1);
    f.peer.command("stop");
    const before = f.peer.sent.length;
    f.firstCapture().stream.write(Buffer.alloc(4, 10));
    expect(f.peer.sent).toHaveLength(before);
    f.peer.command("start");
    await flush();
    expect(f.firstCapture().stop).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it("coalesces pending intent while screen authentication is incomplete", async () => {
    const f = fixture();
    f.attach();
    for (let n = 0; n < 100; n++) {
      f.peer.command("start");
      f.peer.command("stop");
    }
    f.peer.command("start");
    f.observation.activate();
    await flush();
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("rejects replay and retires abandoned screen grants", async () => {
    const f = fixture();
    f.attach();
    const replay = f.attach();
    expect(replay.read()?.toString()).toContain("401");
    f.peer.command("start");
    f.observation.close();
    f.observation.activate();
    await flush();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("revokes audio when requester authority changes, including in-flight capture", async () => {
    let current = true;
    const f = fixture({ isCurrent: () => current });
    f.attach();
    f.observation.activate();
    f.peer.command("start");
    await flush();
    current = false;
    f.firstCapture().stream.write(Buffer.alloc(4, 1));
    await flush();
    expect(f.peer.sent.some((value) => Buffer.isBuffer(value))).toBe(false);
    expect(f.firstCapture().stop).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "carries live requester authority into pending capture admission (%s)",
    async (allowed) => {
      const admission = createDeferred();
      const attempted = createDeferred();
      const settled = createDeferred();
      let current = true;
      let admitted = false;
      const nativeGuard = vi.fn();
      const cleanup = vi.fn(async () => undefined);
      const supervisor: ProcessSupervisor = {
        acquireScopeCleanup: () => cleanup,
        cancel() {},
        cancelScope() {},
        async spawn(input: SpawnInput) {
          if (input.mode !== "child") {
            throw new Error("expected native capture");
          }
          if (input.argv[0] === "parec") {
            attempted.resolve();
            await admission.promise;
            try {
              nativeGuard(() => input.assertCurrent?.());
              input.assertCurrent?.();
              admitted = true;
              input.onStdoutRaw?.(Buffer.alloc(4));
            } finally {
              settled.resolve();
            }
          } else {
            input.onStderr?.("Daemon startup complete.\n");
          }
          return {
            runId: input.argv[0]!,
            startedAtMs: 0,
            activity: { resultSettled: false, lastOutputAtMs: 0 },
            wait: () => new Promise(() => {}),
            cancel() {},
          };
        },
      };
      const owner = createManagedLinuxAudio({
        supervisor,
        tempDir: tempDirs.make("desktop-viewer-admission-"),
        env: {},
        assertCurrent() {},
        runtime: { detectBinary: async () => true },
      });
      const audio = await owner.ready;
      const requesterAbort = new AbortController();
      const f = fixture({ isCurrent: () => current, signal: requesterAbort.signal }, audio.source);
      f.attach();
      f.observation.activate();
      f.peer.command("start");
      await attempted.promise;
      current = allowed;
      admission.resolve();
      await settled.promise;
      await flush();
      expect(admitted).toBe(allowed);
      expect(requesterAbort.signal.aborted).toBe(false);
      expect(nativeGuard).toHaveBeenCalledOnce();
      expect(f.peer.sent.filter((frame) => typeof frame === "string")).toEqual(
        allowed ? ['{"state":"started"}'] : [],
      );
      f.observation.close();
      await owner.stop();
      expect(cleanup).toHaveBeenCalledTimes(2);
    },
  );

  it("reports unexpected recorder close and permits a new capture", async () => {
    const f = fixture();
    f.attach();
    f.observation.activate();
    f.peer.command("start");
    await flush();
    f.firstCapture().stream.destroy();
    f.firstCapture().stream.emit("close");
    await flush();
    expect(
      f.peer.sent.some((item) => typeof item === "string" && JSON.parse(item).state === "error"),
    ).toBe(true);
    expect(f.firstCapture().stop).toHaveBeenCalledTimes(1);
    expect(f.firstCapture().stream.listenerCount("data")).toBe(0);
    f.peer.command("start");
    await flush();
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it("bounds slow-reader buffers instead of accumulating delayed sound", async () => {
    const f = fixture();
    f.attach();
    f.observation.activate();
    f.peer.command("start");
    await flush();
    f.peer.bufferedAmount = 48_000;
    f.firstCapture().stream.write(Buffer.alloc(4));
    await flush();
    expect(f.peer.closed).toContainEqual([1013, "desktop audio backpressure"]);
    expect(f.firstCapture().signal.aborted).toBe(true);
    expect(f.firstCapture().stop).toHaveBeenCalledTimes(1);
  });

  it("rejects binary or unknown commands without starting capture", async () => {
    const f = fixture();
    f.attach();
    f.observation.activate();
    f.peer.emit("message", Buffer.alloc(4), true);
    await flush();
    expect(f.peer.closed[0]?.[0]).toBe(1008);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("expires unused audio tickets and closes with requester cancellation", async () => {
    vi.useFakeTimers();
    const expired = fixture();
    vi.advanceTimersByTime(60_001);
    const transport = expired.attach();
    expect(transport.read()?.toString()).toContain("401");
    const abort = new AbortController();
    const f = fixture({ isCurrent: () => true, signal: abort.signal });
    f.attach();
    abort.abort();
    f.peer.command("start");
    await flush();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.peer.closed.length).toBeGreaterThan(0);
  });
});
