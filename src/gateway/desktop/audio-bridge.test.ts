import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ProcessSupervisor, SpawnInput } from "../../process/supervisor/types.js";
import { markGatewayIngressTransport } from "../ingress-attribution.js";
import type { RemoteControlUiIngressContext } from "../remote-control-ui-context.js";
import { createRemoteControlUiIngressTestContext } from "../remote-control-ui.test-support.js";
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
  ingress?: RemoteControlUiIngressContext,
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
  const observation = mintDesktopAudioObserver({
    source: source ?? { start },
    requester: ingress
      ? {
          ...requester,
          isCurrent: () => requester?.isCurrent() ?? true,
          remoteIngressPrincipal: ingress.resolvePrincipal(),
        }
      : requester,
  });
  cleanups.push(observation.close);
  const peer = new Peer();
  const attach = (path = observation.descriptor.wsPath) => {
    peers.next = peer;
    const transport = new PassThrough();
    const req = { url: path } as IncomingMessage;
    if (ingress) {
      markGatewayIngressTransport(req, { kind: "remote-forwarded", context: ingress });
    }
    handleDesktopAudioUpgrade(req, transport, Buffer.alloc(0));
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
  it("keeps remote ingress work pending until recorder teardown settles", async () => {
    const started = createDeferred();
    const stopping = createDeferred();
    const stopped = createDeferred();
    const grant = new AbortController();
    const tracked: Promise<unknown>[] = [];
    const ingress = createRemoteControlUiIngressTestContext({
      signal: grant.signal,
      trackWork(work) {
        tracked.push(work);
        return work;
      },
    });
    const f = fixture(
      undefined,
      {
        async start() {
          started.resolve();
          return {
            stream: new PassThrough(),
            async stop() {
              stopping.resolve();
              await stopped.promise;
            },
          };
        },
      },
      ingress,
    );
    f.attach();
    f.observation.activate();
    f.peer.command("start");
    await started.promise;
    let settled = false;
    const drain = Promise.all(tracked).then(() => {
      settled = true;
    });
    grant.abort();
    await stopping.promise;
    try {
      expect(settled).toBe(false);
    } finally {
      stopped.resolve();
    }
    await drain;
    expect(settled).toBe(true);
  });

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

  it.each([false, true])(
    "serializes capture intent (pending authentication: %s)",
    async (pending) => {
      const f = fixture();
      f.attach();
      if (pending) {
        for (let n = 0; n < 100; n++) {
          f.peer.command("start");
          f.peer.command("stop");
        }
        f.peer.command("start");
      }
      f.observation.activate();
      await flush();
      if (!pending) {
        expect(f.start).not.toHaveBeenCalled();
        f.peer.command("start");
        await flush();
      }
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
    },
  );

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

  it.each(["revocation", "recorder close", "backpressure"] as const)(
    "stops active capture on %s",
    async (event) => {
      let current = true;
      const f = fixture({ isCurrent: () => current });
      f.attach();
      f.observation.activate();
      f.peer.command("start");
      await flush();
      const capture = f.firstCapture();
      if (event === "recorder close") {
        capture.stream.destroy();
        capture.stream.emit("close");
      } else {
        current = event !== "revocation";
        f.peer.bufferedAmount = event === "backpressure" ? 48_000 : 0;
        capture.stream.write(Buffer.alloc(4, 1));
      }
      await flush();
      expect(capture.stop).toHaveBeenCalledTimes(1);
      if (event === "revocation") {
        expect(f.peer.sent.some((value) => Buffer.isBuffer(value))).toBe(false);
      } else if (event === "backpressure") {
        expect(f.peer.closed).toContainEqual([1013, "desktop audio backpressure"]);
        expect(capture.signal.aborted).toBe(true);
      } else {
        expect(
          f.peer.sent.some(
            (item) => typeof item === "string" && JSON.parse(item).state === "error",
          ),
        ).toBe(true);
        expect(capture.stream.listenerCount("data")).toBe(0);
        f.peer.command("start");
        await flush();
        expect(f.start).toHaveBeenCalledTimes(2);
      }
    },
  );

  it.each([
    [true, "requester"],
    [false, "requester"],
    [false, "ingress"],
  ] as const)(
    "carries live authority into pending capture admission (%s, %s)",
    async (allowed, authority) => {
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
      const ingress =
        authority === "ingress"
          ? createRemoteControlUiIngressTestContext({
              assertCurrent() {
                if (!current) {
                  throw new Error("ingress revoked");
                }
              },
            })
          : undefined;
      const f = fixture(
        { isCurrent: () => authority === "ingress" || current, signal: requesterAbort.signal },
        audio.source,
        ingress,
      );
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
