import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { WebSocket as NpmWebSocket } from "../../../packages/gateway-client/src/websocket.js";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  expectUnauthorizedUpgrade,
  closeServer,
  setupDesktopDiagnostics,
} from "./desktop.test-support.js";
import { mintDesktopObserverToken } from "./observe-bridge.js";
import {
  resolveDesktopObserveRequester,
  type DesktopObserveRequester,
} from "./observe-requester.js";
import { startObserveGateway } from "./observe.test-support.js";
import type { RfbPreauthDescriptor } from "./rfb-preauth.js";
import { createDesktopSessionRegistry, type DesktopSessionRegistry } from "./session-registry.js";

const cleanup: Array<() => Promise<void>> = [];
const HELLO = Buffer.concat([Buffer.from("RFB 003.008\n", "ascii"), Buffer.from([1, 1])]);
const KEY_EVENT = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
const UPDATE_REQUEST = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
const captureLogs = setupDesktopDiagnostics(cleanup, "desktop-observer-diagnostics-", true);

async function expectCloseLog(
  capture: ReturnType<ReturnType<typeof setupDesktopDiagnostics>>,
  attributes: Record<string, unknown>,
) {
  await expect
    .poll(async () => {
      await capture.flush();
      return capture.records.filter((record) => record.message === "desktop observer closed");
    })
    .toHaveLength(1);
  expect(capture.records[0]?.attributes).toMatchObject(attributes);
}

function closedSocket(ws: WebSocket) {
  return new Promise<[number, string]>((resolve) => {
    ws.once("close", (code, reason) => resolve([code, reason.toString()]));
  });
}

function nextFrame(ws: WebSocket) {
  return new Promise<Buffer>((resolve) => {
    ws.once("message", (data) => resolve(Buffer.from(data as Buffer)));
  });
}

function mintUnused(overrides: Partial<Parameters<typeof mintDesktopObserverToken>[0]> = {}) {
  return mintDesktopObserverToken({
    sourceKey: "worker:unused",
    ownerEpoch: 1,
    control: false,
    attachment: { kind: "unix-socket", socketPath: "/tmp/unused-desktop.sock" },
    ...overrides,
  });
}

async function createProxyHarness(
  params: {
    control?: boolean;
    stream?: Duplex;
    preauth?: RfbPreauthDescriptor;
    requester?: DesktopObserveRequester;
    registry?: DesktopSessionRegistry;
  } = {},
) {
  // macOS sockaddr_un cannot hold the test runner's nested temporary path.
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "oc-desktop-observe-"));
  const localSocketPath = path.join(root, "desktop.sock");
  let desktopPeer: net.Socket | undefined;
  const peerConnected = createDeferred<net.Socket>();
  const server = net.createServer((socket) => {
    desktopPeer = socket;
    peerConnected.resolve(socket);
  });
  cleanup.push(async () => {
    desktopPeer?.destroy();
    params.stream?.destroy();
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true });
  });
  const serverReady = once(server, "listening");
  server.listen(localSocketPath);
  await serverReady;
  const release = vi.fn();
  const closeObserver = vi.fn();
  const url = await startObserveGateway(
    cleanup,
    params.registry ?? {
      claimStream: () => params.stream,
      attachObserver: (_environmentId, observer) => {
        closeObserver.mockImplementation((code: number, reason: string) =>
          observer.close(code, reason),
        );
        return { release };
      },
    },
  );
  const serverTimers = vi.isFakeTimers() ? vi.getTimerCount() : undefined;
  const minted = mintDesktopObserverToken({
    sourceKey: "worker:pump",
    ownerEpoch: 2,
    control: params.control ?? false,
    attachment: params.stream
      ? { kind: "stream", streamId: "synthetic-stream" }
      : { kind: "unix-socket", socketPath: localSocketPath },
    ...(params.preauth ? { preauth: params.preauth } : {}),
    requester: params.requester,
  });
  const ws = new WebSocket(`${url}/desktop/observe?token=${minted.token}`);
  cleanup.push(async () => ws.terminate());
  await once(ws, "open");
  return {
    closeObserver,
    desktopPeer: params.stream ?? (await peerConnected.promise),
    observerUrl: ws.url,
    release,
    serverTimers,
    ws,
  };
}

const expectUnauthorizedObserver = (url: string) => expectUnauthorizedUpgrade(url, cleanup);
function expectUnauthorizedToken(url: string, token: string) {
  const observerUrl = new URL(url);
  observerUrl.searchParams.set("token", token);
  return expectUnauthorizedObserver(observerUrl.toString());
}

describe.runIf(process.platform !== "win32")("worker desktop observer proxy", () => {
  it.each([
    {
      displayName: "  ",
      userId: "morgan@example.test",
      reason: "control-taken:morgan@example.test",
    },
    { displayName: null, userId: undefined, reason: "control-taken" },
    { displayName: "🦞".repeat(28), userId: undefined, reason: `control-taken:${"🦞".repeat(27)}` },
  ])(
    "identifies a controller takeover with a valid close reason ($reason)",
    async ({ displayName, userId, reason }) => {
      const registry = createDesktopSessionRegistry();
      cleanup.push(() => registry.stopAll());
      await registry.activate({ sourceKey: "worker:pump", ownerEpoch: 2 });
      const previous = await createProxyHarness({ control: true, registry });
      const closed = closedSocket(previous.ws);
      const requester = resolveDesktopObserveRequester({
        client: {
          authenticatedUserId: userId,
          authenticatedUserProfile: {
            profileId: "synthetic-profile",
            displayName,
            hasAvatar: false,
            updatedAt: 0,
          },
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
              id: GATEWAY_CLIENT_IDS.CONTROL_UI,
              displayName: "Unverified wire name",
              version: "test",
              platform: "test",
              mode: "webchat",
            },
          },
        },
      });
      const current = await createProxyHarness({ control: true, registry, requester });
      await expect(closed).resolves.toEqual([4000, reason]);
      expect(Buffer.byteLength(reason)).toBeLessThanOrEqual(123);
      expect(current.ws.readyState).toBe(WebSocket.OPEN);
    },
  );

  it("keeps an idle observer alive without adding bytes to RFB and retires on owner close", async () => {
    const logCapture = captureLogs();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const harness = await createProxyHarness({ control: true });
    expect(vi.getTimerCount()).toBe(harness.serverTimers! + 1);
    const pings: Buffer[] = [];
    const onDesktopData = vi.fn();
    harness.ws.on("ping", (data) => pings.push(data));
    harness.desktopPeer.on("data", onDesktopData);

    vi.advanceTimersByTime(25_000);
    await expect.poll(() => pings.length).toBe(1);
    vi.advanceTimersByTime(25_000);
    await expect.poll(() => pings.length).toBe(2);
    expect(onDesktopData).not.toHaveBeenCalled();

    const closed = closedSocket(harness.ws).then(([code]) => code);
    harness.closeObserver(1012, "desktop tunnel closed");
    await expect(closed).resolves.toBe(1012);
    await expectCloseLog(logCapture, {
      sourceKey: "worker:pump",
      ownerEpoch: 2,
      trigger: "owner-close",
      cleanupCode: 1012,
      closeCode: 1012,
    });
    expect(JSON.stringify(logCapture.records)).not.toContain(harness.observerUrl);
    expect(harness.release).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(25_000);
    expect(pings).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(harness.serverTimers);
  });

  it("clears the credential-bearing token timer when the token is consumed", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    await createProxyHarness({
      preauth: {
        auth: "ard-account",
        credentials: { username: "operator", password: "memory-only-password" },
      },
    });
    const expiryCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 60_000);
    expect(expiryCallIndex).toBeGreaterThanOrEqual(0);
    const expiryTimer = setTimeoutSpy.mock.results[expiryCallIndex]?.value;
    expect(clearTimeoutSpy).toHaveBeenCalledWith(expiryTimer);
  });

  it("rejects consumed, expired, and unknown tokens", async () => {
    const harness = await createProxyHarness();
    await expectUnauthorizedObserver(harness.observerUrl);

    await expectUnauthorizedToken(harness.observerUrl, mintUnused({ nowMs: 0 }).token);
    await expectUnauthorizedToken(harness.observerUrl, "0".repeat(48));
  });

  it.each([
    "invalidated",
    "invalidate-after-mint",
    "abort-before-mint",
    "abort-after-mint",
  ] as const)(
    "refuses an unused requester token before its TTL expires (%s)",
    async (revocation) => {
      const harness = await createProxyHarness();
      const controller = new AbortController();
      let invalidated = revocation === "invalidated";
      if (revocation === "abort-before-mint") {
        controller.abort();
      }
      const minted = mintUnused({
        requester: {
          signal: controller.signal,
          isCurrent: () => !invalidated && !controller.signal.aborted,
        },
      });
      if (revocation === "abort-after-mint") {
        controller.abort();
      }
      invalidated = true;
      expect(controller.signal.aborted).toBe(revocation.startsWith("abort-"));
      expect(minted.expiresAtMs).toBeGreaterThan(Date.now());
      await expectUnauthorizedToken(harness.observerUrl, minted.token);
    },
  );

  it.each(["desktop", "browser", "abort"] as const)(
    "retires an attached requester before relaying revoked bytes (%s)",
    async (trigger) => {
      const controller = new AbortController();
      const client = { invalidated: false };
      const received: Buffer[] = [];
      const stream = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          received.push(Buffer.from(chunk));
          callback();
        },
      });
      const harness = await createProxyHarness({
        control: true,
        stream,
        requester: {
          signal: controller.signal,
          isCurrent: () => !client.invalidated && !controller.signal.aborted,
        },
      });
      const frames: Buffer[] = [];
      harness.ws.on("message", (data) => frames.push(Buffer.from(data as Buffer)));
      const closed = closedSocket(harness.ws);
      client.invalidated = true;
      if (trigger === "abort") {
        controller.abort();
      } else {
        if (trigger === "desktop") {
          stream.push(Buffer.from("revoked framebuffer"));
        }
        harness.ws.send(KEY_EVENT);
      }
      await expect.poll(() => harness.ws.readyState).toBe(WebSocket.CLOSED);
      await expect(closed).resolves.toEqual([4006, "authority_revoked"]);
      expect(frames).toEqual([]);
      expect(received).toEqual([]);
      expect(controller.signal.aborted).toBe(trigger === "abort");
      expect(stream.destroyed).toBe(true);
      expect(harness.release).toHaveBeenCalledOnce();
    },
  );

  it("closes malformed view-only streams with a policy violation", async () => {
    const harness = await createProxyHarness();
    const closed = closedSocket(harness.ws);
    harness.ws.send(
      Buffer.concat([Buffer.from("RFB 003.008\n", "ascii"), Buffer.from([1, 1, 254])]),
    );
    await expect(closed).resolves.toEqual([1008, "invalid view-only RFB stream"]);
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it("propagates websocket close to the unix socket", async () => {
    const logCapture = captureLogs();
    const harness = await createProxyHarness();
    const closed = new Promise<void>((resolve) => {
      harness.desktopPeer.once("close", resolve);
    });
    const token = new URL(harness.observerUrl).searchParams.get("token");
    harness.ws.close(1001, `browser left\n${token}`);
    await closed;
    await logCapture.flush();
    expect(logCapture.records).toHaveLength(1);
    expect(logCapture.records[0]?.attributes).toMatchObject({
      trigger: "browser-close",
      cleanupCode: 1000,
      closeCode: 1001,
    });
    expect(logCapture.records[0]?.attributes?.closeReason).toBeUndefined();
    const serialized = JSON.stringify(logCapture.records);
    expect(serialized).not.toContain("browser left");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(harness.observerUrl);
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "bounds browser writes, resumes on drain, and closes a blocked desktop (control: %s)",
    async (control) => {
      const received: Buffer[] = [];
      let blocked = true;
      let releaseWrite: (() => void) | undefined;
      const pause = vi.spyOn(NpmWebSocket.prototype, "pause");
      const stream = new Duplex({
        writableHighWaterMark: 1,
        read() {},
        write(chunk, _encoding, callback) {
          received.push(Buffer.from(chunk));
          if (blocked) {
            releaseWrite = callback;
          } else {
            callback();
          }
        },
      });
      const harness = await createProxyHarness({
        control,
        stream,
        requester: { signal: new AbortController().signal, isCurrent: () => true },
      });
      const pulse = nextFrame(harness.ws);
      stream.push(Buffer.from("synthetic-server-pulse"));
      await expect(pulse).resolves.toEqual(Buffer.from("synthetic-server-pulse"));
      harness.ws.send(HELLO);
      await expect.poll(() => releaseWrite).toBeDefined();
      const gatewaySocket = pause.mock.contexts.at(-1);
      if (!(gatewaySocket instanceof NpmWebSocket)) {
        throw new Error("Expected the paused Gateway WebSocket.");
      }
      expect(gatewaySocket?.isPaused).toBe(true);
      expect(stream.writableLength).toBe(HELLO.length);
      harness.ws.send(Buffer.concat([KEY_EVENT, UPDATE_REQUEST]));
      blocked = false;
      releaseWrite?.();
      releaseWrite = undefined;
      const expected = Buffer.concat([HELLO, ...(control ? [KEY_EVENT] : []), UPDATE_REQUEST]);
      await expect.poll(() => Buffer.concat(received)).toEqual(expected);
      await expect.poll(() => gatewaySocket?.isPaused).toBe(false);

      blocked = true;
      harness.ws.send(UPDATE_REQUEST);
      await expect.poll(() => releaseWrite).toBeDefined();
      expect(gatewaySocket?.isPaused).toBe(true);
      const closed = closedSocket(harness.ws).then(([code]) => code);
      harness.closeObserver(1012, "desktop tunnel closed");
      await expect(closed).resolves.toBe(1012);
      expect(stream.destroyed).toBe(true);
      expect(stream.listenerCount("drain")).toBe(0);
      expect(harness.release).toHaveBeenCalledOnce();
    },
  );

  it("expires unused credential-bearing tokens without a later token operation", async () => {
    const harness = await createProxyHarness();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const minted = mintUnused({
      preauth: {
        auth: "vnc-password",
        credentials: { password: "synthetic-memory-only-password" },
      },
    });

    vi.advanceTimersByTime(60_000);
    // Wall-clock expiry still lies ahead; only the timer could have retired this token.
    expect(minted.expiresAtMs).toBeGreaterThan(Date.now());
    expect(vi.getTimerCount()).toBe(0);
    // Only token expiry uses virtual time; socket rejection and teardown use real timers.
    vi.useRealTimers();
    await expectUnauthorizedToken(harness.observerUrl, minted.token);
  });

  it("pauses and resumes unix-socket reads around websocket backpressure", async () => {
    const logCapture = captureLogs();
    let bufferedAmount = 5 * 1024 * 1024;
    const pause = vi.spyOn(net.Socket.prototype, "pause");
    const resume = vi.spyOn(net.Socket.prototype, "resume");
    vi.spyOn(NpmWebSocket.prototype, "bufferedAmount", "get").mockImplementation(
      () => bufferedAmount,
    );
    const harness = await createProxyHarness();
    pause.mockClear();
    resume.mockClear();
    harness.desktopPeer.write(Buffer.from("RFB"));
    await vi.waitFor(() => expect(pause).toHaveBeenCalled());
    bufferedAmount = 0;
    await vi.waitFor(() => expect(resume).toHaveBeenCalled());
    const closed = closedSocket(harness.ws);
    harness.desktopPeer.destroy();
    await closed;
    await expectCloseLog(logCapture, {
      trigger: "stream-close",
      cleanupCode: 1000,
      closeCode: 1000,
    });
    expect(harness.release).toHaveBeenCalledOnce();
  });
});
