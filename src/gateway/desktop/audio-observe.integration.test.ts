import { once } from "node:events";
import http from "node:http";
import { duplexPair, PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred } from "../../../test/helpers/promise.js";
import { handleDesktopAudioUpgrade } from "./audio-bridge.js";
import { closeServer, listenLoopback } from "./desktop.test-support.js";
import {
  handleDesktopObserveUpgrade,
  mintDesktopObserverToken,
  releaseDesktopObserverToken,
} from "./observe-bridge.js";
import type { DesktopSessionRegistry } from "./session-registry.js";
const version = Buffer.from("RFB 003.008\n");
const httpServer = http.createServer();
let origin = "";
let registry: Pick<DesktopSessionRegistry, "attachObserver" | "claimStream">;
const cleanups: Array<() => void> = [];
beforeAll(async () => {
  httpServer.on("upgrade", (req, socket, head) => {
    if (!handleDesktopAudioUpgrade(req, socket, head)) {
      handleDesktopObserveUpgrade(req, socket, head, { registry });
    }
  });
  origin = "ws://127.0.0.1:" + (await listenLoopback(httpServer));
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});
afterAll(() => closeServer(httpServer));
async function attach(path: string) {
  const socket = new WebSocket(origin + path);
  cleanups.push(() => socket.terminate());
  await once(socket, "open");
  return socket;
}
it.each(["success", "rejected", "released", "expired", "stale-owner"] as const)(
  "does not bypass screen authorization: %s",
  async (outcome) => {
    if (outcome === "expired") {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    }
    const [gatewayStream, serverStream] = duplexPair();
    cleanups.push(() => {
      gatewayStream.destroy();
      serverStream.destroy();
    });
    const authenticated = createDeferred();
    const stopped = createDeferred();
    const pcm = new PassThrough();
    const stop = vi.fn(async () => {
      pcm.destroy();
      stopped.resolve();
    });
    const start = vi.fn(async (_signal: AbortSignal) => ({ stream: pcm, stop }));
    registry = {
      claimStream: () => gatewayStream,
      attachObserver: () => (outcome === "stale-owner" ? undefined : { release() {} }),
    };
    const requester = { connId: "audio-authorization-test", isCurrent: () => true };
    const grant = mintDesktopObserverToken({
      sourceKey: "host",
      ownerEpoch: 1,
      control: true,
      attachment: { kind: "stream", streamId: "synthetic-rfb" },
      preauth: { auth: "vnc-password", credentials: { password: "synthetic" } },
      audio: { start },
      requester,
    });
    expect(grant.audio).toBeDefined();
    const audio = await attach(grant.audio!.wsPath);
    const audioClosed = once(audio, "close");
    const expectAudioDenied = async () => {
      await audioClosed;
      expect(start).not.toHaveBeenCalled();
    };
    audio.send(JSON.stringify({ action: "start" }));
    if (outcome === "released") {
      expect(
        await releaseDesktopObserverToken("/desktop/observe?token=" + grant.token, requester),
      ).toBe(true);
      return expectAudioDenied();
    }
    if (outcome === "expired") {
      vi.advanceTimersByTime(60_001);
      return expectAudioDenied();
    }
    const upstreamReplies = [Buffer.from([1, 2]), Buffer.alloc(16, 1)];
    serverStream.on("data", () => {
      const reply = upstreamReplies.shift();
      if (reply) {
        serverStream.write(reply);
      } else {
        authenticated.resolve();
      }
    });
    const screen = new WebSocket(origin + "/desktop/observe?token=" + grant.token);
    cleanups.push(() => screen.terminate());
    const browserReplies = [version, Buffer.from([1])];
    screen.on("message", () => {
      const reply = browserReplies.shift();
      if (reply) {
        screen.send(reply);
      }
    });
    await once(screen, "open");
    if (outcome === "stale-owner") {
      return expectAudioDenied();
    }
    serverStream.write(version);
    await authenticated.promise;
    expect(start).not.toHaveBeenCalled();
    if (outcome === "rejected") {
      serverStream.write(Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]));
      return expectAudioDenied();
    }
    const startFrame = once(audio, "message");
    serverStream.write(Buffer.alloc(4));
    expect((await startFrame)[0].toString()).toBe('{"state":"started"}');
    expect(start).toHaveBeenCalledTimes(1);
    const received = once(audio, "message");
    const samples = Buffer.from([0, 1, 0, 2]);
    pcm.write(samples);
    expect(await received).toEqual([samples, true]);
    screen.close();
    await audioClosed;
    await stopped.promise;
    expect(pcm.destroyed).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0].aborted).toBe(true);
  },
);
