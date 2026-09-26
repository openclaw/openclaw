import { once } from "node:events";
import http from "node:http";
import { duplexPair, PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred } from "../../../test/helpers/promise.js";
import { handleDesktopAudioUpgrade } from "./audio-bridge.js";
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
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test address");
  }
  origin = "ws://127.0.0.1:" + address.port;
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});
afterAll(async () => {
  httpServer.close();
  await once(httpServer, "close");
});
async function attach(path: string) {
  const socket = new WebSocket(origin + path);
  cleanups.push(() => socket.terminate());
  await once(socket, "open");
  return socket;
}
describe("audio tied to the actual RFB observer", () => {
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
      const started = createDeferred();
      const stopped = createDeferred();
      const pcm = new PassThrough();
      const start = vi.fn(async () => {
        started.resolve();
        return {
          stream: pcm,
          stop: async () => {
            pcm.destroy();
            stopped.resolve();
          },
        };
      });
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
      audio.send(JSON.stringify({ action: "start" }));
      if (outcome === "released") {
        expect(
          await releaseDesktopObserverToken("/desktop/observe?token=" + grant.token, requester),
        ).toBe(true);
        await audioClosed;
        expect(start).not.toHaveBeenCalled();
        return;
      }
      if (outcome === "expired") {
        vi.advanceTimersByTime(60_001);
        await audioClosed;
        expect(start).not.toHaveBeenCalled();
        return;
      }
      let upstreamStage = 0;
      serverStream.on("data", () => {
        if (upstreamStage++ === 0) {
          serverStream.write(Buffer.from([1, 2]));
        } else if (upstreamStage === 2) {
          serverStream.write(Buffer.alloc(16, 1));
        } else {
          authenticated.resolve();
        }
      });
      const screen = new WebSocket(origin + "/desktop/observe?token=" + grant.token);
      cleanups.push(() => screen.terminate());
      let browserStage = 0;
      screen.on("message", () => {
        if (browserStage++ === 0) {
          screen.send(version);
        } else if (browserStage === 2) {
          screen.send(Buffer.from([1]));
        }
      });
      await once(screen, "open");
      if (outcome === "stale-owner") {
        await audioClosed;
        expect(start).not.toHaveBeenCalled();
        return;
      }
      serverStream.write(version);
      await authenticated.promise;
      expect(start).not.toHaveBeenCalled();
      if (outcome === "rejected") {
        serverStream.write(Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]));
        await audioClosed;
        expect(start).not.toHaveBeenCalled();
        return;
      }
      serverStream.write(Buffer.alloc(4));
      await started.promise;
      expect(start).toHaveBeenCalledTimes(1);
      screen.close();
      await audioClosed;
      await stopped.promise;
      expect(pcm.destroyed).toBe(true);
    },
  );
});
