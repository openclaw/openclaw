import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { markGatewayIngressTransport } from "../ingress-attribution.js";
import { createRemoteControlUiIngressTestContext } from "../remote-control-ui.test-support.js";

const peers = vi.hoisted(() => ({ next: undefined as unknown, authenticate: vi.fn() }));
// mock-isolation: Exercise observer ownership without opening a physical WebSocket or listener.
vi.mock("../../../packages/gateway-client/src/websocket.js", () => ({
  WebSocket: { OPEN: 1 },
  WebSocketServer: class {
    handleUpgrade(_req: unknown, _socket: unknown, _head: unknown, accept: (ws: unknown) => void) {
      accept(peers.next);
    }
  },
}));
// mock-isolation: Heartbeat timers are unrelated to pending authentication teardown.
vi.mock("../websocket-keepalive.js", () => ({ startWebSocketKeepalive: () => () => {} }));
vi.mock("./rfb-preauth.js", async (original) => ({
  ...(await original<typeof import("./rfb-preauth.js")>()),
  preauthenticateRfb: peers.authenticate,
}));
import { handleDesktopAudioUpgrade, mintDesktopAudioObserver } from "./audio-bridge.js";
import { handleDesktopObserveUpgrade, mintDesktopObserverToken } from "./observe-bridge.js";

it("retains pending observer authentication until its actual work settles after ingress closure", async () => {
  const authentication = createDeferred();
  peers.authenticate.mockImplementation(() => authentication.promise);
  const grant = new AbortController();
  const work: Promise<unknown>[] = [];
  const context = createRemoteControlUiIngressTestContext({
    signal: grant.signal,
    trackWork(pending) {
      work.push(pending);
      return pending;
    },
  });
  const desktop = new PassThrough();
  const transport = new PassThrough();
  const peer = Object.assign(new EventEmitter(), {
    readyState: 1,
    resume: vi.fn(),
    pause: vi.fn(),
    close: vi.fn((code: number, reason: string) => {
      peer.readyState = 3;
      peer.emit("close", code, Buffer.from(reason));
    }),
  });
  peers.next = peer;
  const ticket = mintDesktopObserverToken({
    sourceKey: "desktop:fixture",
    ownerEpoch: 1,
    control: false,
    attachment: { kind: "stream", streamId: "fixture-stream" },
    preauth: { auth: "vnc-password", credentials: { password: "fixture-password" } },
    requester: { isCurrent: () => true, remoteIngressPrincipal: context.resolvePrincipal() },
  });
  const req = new IncomingMessage(new Socket());
  req.url = `/desktop/observe?token=${ticket.token}`;
  markGatewayIngressTransport(req, { kind: "remote-forwarded", context });
  const release = vi.fn();
  try {
    expect(
      handleDesktopObserveUpgrade(req, transport, Buffer.alloc(0), {
        registry: { claimStream: () => desktop, attachObserver: () => ({ release }) },
      }),
    ).toBe(true);
    grant.abort();
    let settled = false;
    const drain = Promise.all(work).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledWith(4006, "authority_revoked");
    authentication.resolve();
    await drain;
    expect(settled).toBe(true);
  } finally {
    authentication.resolve();
    await Promise.all(work);
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
    const path =
      audio?.descriptor.wsPath ??
      `/desktop/observe?token=${
        mintDesktopObserverToken({
          sourceKey: "desktop:fixture",
          ownerEpoch: 1,
          control: false,
          attachment: { kind: "stream", streamId: "fixture-stream" },
          requester,
        }).token
      }`;
    const req = new IncomingMessage(new Socket());
    req.url = path;
    markGatewayIngressTransport(req, { kind: "remote-forwarded", context: destination });
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
      req.destroy();
      transport.destroy();
    }
  },
);
