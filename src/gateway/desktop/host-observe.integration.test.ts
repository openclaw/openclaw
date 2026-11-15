import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSocketServer, listenLoopback } from "./desktop.test-support.js";
import { createHostDesktopService } from "./host-source.js";
import {
  connectRfbObserver,
  RFB_VERSION as VERSION,
  startObserveGateway,
} from "./observe.test-support.js";
import { createDesktopSessionRegistry } from "./session-registry.js";
import { SocketReader } from "./socket-reader.test-support.js";

const FRAMEBUFFER_REQUEST = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
const cleanups: Array<() => Promise<void>> = [];

afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

it.each(["connected", "access denied", "invalid security"] as const)(
  "preserves ARD authentication, access rejection, and protocol failure (%s)",
  async (outcome) => {
    let connectionCount = 0;
    const script = createDeferred();
    const browserReady = createDeferred();
    const { server: rfbServer } = createSocketServer(cleanups, (socket) => {
      connectionCount += 1;
      const connectionIndex = connectionCount;
      const reader = new SocketReader(socket);
      void (async () => {
        try {
          socket.write(Buffer.from("RFB 003.889\n", "ascii"));
          expect(await reader.readExactly(12)).toEqual(VERSION);
          socket.write(Buffer.from([4, 30, 33, 36, 35]));
          if (connectionIndex === 1) {
            return;
          }

          expect(await reader.readExactly(1)).toEqual(Buffer.from([30]));
          const keyLength = 16;
          const header = Buffer.alloc(4);
          header.writeUInt16BE(5, 0);
          header.writeUInt16BE(outcome === "invalid security" ? 0 : keyLength, 2);
          const modulus = Buffer.alloc(keyLength);
          modulus.writeUInt16BE(7919, keyLength - 2);
          const serverPublic = Buffer.alloc(keyLength);
          serverPublic.writeUInt16BE(6817, keyLength - 2);
          await browserReady.promise;
          socket.write(Buffer.concat([header, modulus, serverPublic]));
          if (outcome === "invalid security") {
            script.resolve();
            return;
          }
          expect(await reader.readExactly(128 + keyLength)).toHaveLength(128 + keyLength);
          if (outcome === "access denied") {
            const reason = Buffer.from("access denied for operator using account-password");
            const result = Buffer.alloc(8);
            result.writeUInt32BE(1, 0);
            result.writeUInt32BE(reason.length, 4);
            socket.write(Buffer.concat([result, reason]));
            script.resolve();
            return;
          }
          socket.write(Buffer.alloc(4));

          // Browser version/security bytes were consumed by the Gateway. ClientInit is first.
          expect(await reader.readExactly(1)).toEqual(Buffer.from([1]));
          socket.write(Buffer.from("server-init", "ascii"));
          expect(await reader.readExactly(FRAMEBUFFER_REQUEST.length)).toEqual(FRAMEBUFFER_REQUEST);
          script.resolve();
        } catch (error) {
          script.reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
    const port = await listenLoopback(rfbServer);

    const registry = createDesktopSessionRegistry();
    const service = createHostDesktopService({
      getConfig: () => ({ enabled: true, port }),
      registry,
    });
    cleanups.push(async () => registry.stopAll());
    const observed = await service.observe({
      control: false,
      credentials: { username: "operator", password: "account-password" },
    });
    expect(observed.auth).toBe("ard-account");
    expect(observed.vncPassword).toBeUndefined();

    const gateway = await startObserveGateway(cleanups, registry);
    const { ws, nextFrame, closed } = await connectRfbObserver(
      cleanups,
      `${gateway}${observed.wsPath}`,
    );
    browserReady.resolve();
    if (outcome !== "connected") {
      const result = await closed;
      expect(result).toEqual(
        outcome === "access denied"
          ? {
              code: 1008,
              reason:
                "macOS denied desktop access; check credentials and Screen Sharing or Remote Management Observe/Control permissions",
            }
          : {
              code: 1011,
              reason:
                "desktop security negotiation failed; check the desktop service and reconnect",
            },
      );
      expect(Buffer.byteLength(result.reason)).toBeLessThanOrEqual(123);
      expect(result.reason).not.toContain("account-password");
      await expect(script.promise).resolves.toBeUndefined();
      return;
    }
    expect(await nextFrame()).toEqual(Buffer.alloc(4));
    expect(await nextFrame()).toEqual(Buffer.from("server-init", "ascii"));

    const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    ws.send(Buffer.concat([keyEvent, FRAMEBUFFER_REQUEST]));
    await expect(script.promise).resolves.toBeUndefined();
    await vi.waitFor(() => expect(connectionCount).toBe(2));
  },
);
