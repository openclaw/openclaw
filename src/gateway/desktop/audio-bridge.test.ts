import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { markGatewayIngressTransport } from "../ingress-attribution.js";
import { createRemoteControlUiIngressTestContext } from "../remote-control-ui.test-support.js";
import type { RemoteControlUiIngressContext } from "../server/client-identity-types.js";
import { createAudioFixture } from "./audio.test-support.js";
import type { DesktopAudioSource } from "./managed-linux-audio.js";

const peers = vi.hoisted(() => ({ next: undefined as unknown, authenticate: vi.fn() }));
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
vi.mock("./rfb-preauth.js", async (original) => ({
  ...(await original<typeof import("./rfb-preauth.js")>()),
  preauthenticateRfb: peers.authenticate,
}));
import { handleDesktopAudioUpgrade, mintDesktopAudioObserver } from "./audio-bridge.js";
import { handleDesktopObserveUpgrade, mintDesktopObserverToken } from "./observe-bridge.js";

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
class ObserverPeer extends Peer {
  resume = vi.fn();
  pause = vi.fn();
  override close(code: number, reason: string) {
    super.close(code, reason);
    this.emit("close", code, Buffer.from(reason));
  }
}
const observerDefaults = {
  sourceKey: "desktop:fixture",
  ownerEpoch: 1,
  control: false,
  attachment: { kind: "stream" as const, streamId: "fixture-stream" },
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const flush = async () => {
  for (let n = 0; n < 12; n++) {
    await Promise.resolve();
  }
};

function ingressRequest(url: string, context: RemoteControlUiIngressContext) {
  const req = { url } as IncomingMessage;
  markGatewayIngressTransport(req, { kind: "remote-forwarded", context });
  return req;
}

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
    const req = ingress ? ingressRequest(path, ingress) : ({ url: path } as IncomingMessage);
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
  it.each([false, true])(
    "serializes capture intent (pending authentication: %s)",
    async (pending) => {
      const f = fixture();
      f.attach();
      await flush();
      expect(f.start).not.toHaveBeenCalled();
      if (pending) {
        for (let n = 0; n < 100; n++) {
          f.peer.command("start");
          f.peer.command("stop");
        }
        f.peer.command("start");
        await flush();
        expect(f.start).not.toHaveBeenCalled();
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
      let current = true;
      const native = createAudioFixture(tempDirs.make("desktop-viewer-admission-"), {
        deferCapture: true,
      });
      const audio = await native.owner.ready;
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
      await native.captureSpawned.promise;
      current = allowed;
      native.captureAdmission.resolve();
      await native.captureSettled.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(native.captureAdmitted).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(requesterAbort.signal.aborted).toBe(false);
      expect(f.peer.sent.filter((frame) => Buffer.isBuffer(frame))).toEqual(
        allowed ? [Buffer.from([0, 128, 255, 127])] : [],
      );
      expect(f.peer.sent.filter((frame) => typeof frame === "string")).toEqual(
        allowed ? ['{"state":"started"}'] : [],
      );
      f.observation.close();
      await native.runs[1]!.wait();
      expect(native.runs.map((run) => run.activity.resultSettled)).toEqual([false, true]);
      await native.owner.stop();
      expect(native.scopeCleaned).toHaveBeenCalledTimes(2);
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

it("rechecks ingress authority before publishing after observer authentication", async () => {
  const authentication = createDeferred();
  peers.authenticate.mockImplementation(() => authentication.promise);
  let current = true;
  const context = createRemoteControlUiIngressTestContext({
    assertCurrent() {
      if (!current) {
        throw new Error("ingress revoked");
      }
    },
  });
  const desktop = new PassThrough();
  const transport = new PassThrough();
  const peer = new ObserverPeer();
  peers.next = peer;
  const ticket = mintDesktopObserverToken({
    ...observerDefaults,
    preauth: { auth: "vnc-password", credentials: { password: "fixture-password" } },
    requester: { isCurrent: () => true, remoteIngressPrincipal: context.resolvePrincipal() },
  });
  const release = vi.fn();
  try {
    expect(
      handleDesktopObserveUpgrade(
        ingressRequest(`/desktop/observe?token=${ticket.token}`, context),
        transport,
        Buffer.alloc(0),
        { registry: { claimStream: () => desktop, attachObserver: () => ({ release }) } },
      ),
    ).toBe(true);
    current = false;
    authentication.resolve();
    await authentication.promise;
    desktop.emit("data", Buffer.from("private desktop bytes"));
    expect(release).toHaveBeenCalledOnce();
    expect(peer.closed).toContainEqual([4006, "authority_revoked"]);
    expect(peer.sent).toEqual([]);
  } finally {
    authentication.resolve();
    await authentication.promise;
    desktop.destroy();
    transport.destroy();
  }
});

it.each(["observe", "audio"] as const)(
  "refuses a %s ticket issued under another ingress grant",
  (kind) => {
    const source = createRemoteControlUiIngressTestContext({
      principal: { kind: "person", profileId: "person-a" },
    });
    const destination = createRemoteControlUiIngressTestContext({
      principal: { kind: "person", profileId: "person-b" },
    });
    const requester = { isCurrent: () => true, remoteIngressPrincipal: source.resolvePrincipal() };
    const audio =
      kind === "audio"
        ? mintDesktopAudioObserver({
            requester,
            source: {
              start: async () => {
                throw new Error("Rejected tickets must not start audio");
              },
            },
          })
        : undefined;
    const req = ingressRequest(
      audio?.descriptor.wsPath ??
        `/desktop/observe?token=${mintDesktopObserverToken({ ...observerDefaults, requester }).token}`,
      destination,
    );
    const transport = new PassThrough();
    const chunks: Buffer[] = [];
    transport.on("data", (chunk: Buffer) => chunks.push(chunk));
    const attachObserver = vi.fn();
    const claimStream = vi.fn();
    try {
      if (kind === "audio") {
        handleDesktopAudioUpgrade(req, transport, Buffer.alloc(0));
      } else {
        handleDesktopObserveUpgrade(req, transport, Buffer.alloc(0), {
          registry: { attachObserver, claimStream },
        });
      }
      expect(Buffer.concat(chunks).toString()).toContain("401 Unauthorized");
      expect(attachObserver).not.toHaveBeenCalled();
      expect(claimStream).not.toHaveBeenCalled();
    } finally {
      audio?.close();
      transport.destroy();
    }
  },
);
