import type net from "node:net";
import type { Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  handlePeerTeardownError,
  createSocketServer,
  listenLoopback,
} from "./desktop.test-support.js";
import { classifyRfbSecurity, connectRfbServer, probeRfbServer } from "./rfb-probe.js";

const cleanups: Array<() => Promise<void>> = [];
const VERSION = Buffer.from("RFB 003.008\n");
const OFFER = Buffer.from([1, 2]);
const CLIENT_HELLO = Buffer.concat([VERSION, Buffer.from([2])]);

afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function listenScriptedRfb(script: (socket: net.Socket) => void): Promise<number> {
  const { server } = createSocketServer(cleanups, script);
  return listenLoopback(server);
}

function probe(port: number, timeoutMs = 2_000) {
  return probeRfbServer({ host: "127.0.0.1", port, timeoutMs });
}

async function connect(port: number, signal?: AbortSignal, securityTypes?: number[]) {
  const result = await connectRfbServer({ host: "127.0.0.1", port, timeoutMs: 2_000, signal });
  expect(result.kind).toBe("rfb");
  if (result.kind !== "rfb") {
    throw new Error("expected retained connection");
  }
  if (securityTypes) {
    expect(result.securityTypes).toEqual(securityTypes);
  }
  const { stream } = result;
  cleanups.push(async () => {
    stream.destroy();
  });
  return stream;
}

function serveHandshake(socket: net.Socket, onSelection: (selection: Buffer) => void) {
  socket.write(VERSION);
  socket.once("data", () => {
    socket.write(OFFER);
    socket.once("data", onSelection);
  });
}

function pauseAfterPrefix(stream: Duplex) {
  return new Promise<Buffer>((resolve) => {
    stream.once("data", (chunk: Buffer) => {
      stream.pause();
      resolve(chunk);
    });
  });
}

describe("RFB server probe", () => {
  it.each([
    ["RFB 3.3", "RFB 003.003\n", Buffer.alloc(4)],
    ["RFB 3.8", "RFB 003.008\n", Buffer.from([0])],
  ])("does not buffer the %s failure reason", async (_name, banner, rejection) => {
    const port = await listenScriptedRfb((socket) => {
      socket.write(Buffer.from(banner, "ascii"));
      socket.once("data", () => {
        const reasonLength = Buffer.alloc(4);
        reasonLength.writeUInt32BE(0xffff_ffff);
        socket.write(Buffer.concat([rejection, reasonLength]));
      });
    });
    await expect(probe(port)).resolves.toEqual({ kind: "rfb", securityTypes: [] });
  });

  it.each([
    ["HTTP/1.1 200 OK\r\n\r\n", "HTTP/1.1 200", false],
    ["RFB 003", "RFB 003", true],
  ])("reports a non-RFB or truncated banner (%s)", async (wire, banner, end) => {
    const port = await listenScriptedRfb((socket) => {
      socket[end ? "end" : "write"](Buffer.from(wire, "ascii"));
    });
    await expect(probe(port)).resolves.toEqual({ kind: "not-rfb", banner });
  });

  it("reports an unreachable port", async () => {
    const port = await listenScriptedRfb(() => undefined);
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    await expect(probe(port)).resolves.toEqual({ kind: "unreachable" });
  });

  it("times out a server that never speaks", async () => {
    const port = await listenScriptedRfb(() => undefined);
    await expect(probe(port, 50)).resolves.toEqual({ kind: "timeout" });
  });
});

describe("configured VncAuth probe", () => {
  it("finishes the handshake before closing and rejects a wrong password", async () => {
    const password = "secret12";
    const challenge = Buffer.alloc(16, 4);
    // Independent of buildVncAuthResponse. Password secret12, challenge 16 bytes of 0x04.
    const expectedResponse = Buffer.from([
      68, 0, 237, 84, 60, 173, 8, 143, 68, 0, 237, 84, 60, 173, 8, 143,
    ]);
    let incomplete = 0;
    let authenticated = 0;
    let rejected = 0;
    const port = await listenScriptedRfb((socket) => {
      const pending: Buffer[] = [];
      let stage: "version" | "select" | "response" | "init" | "done" = "version";
      let settled = false;
      socket.on("close", () => {
        if (!settled) {
          incomplete += 1;
        }
      });
      socket.on("data", (chunk) => {
        pending.push(Buffer.from(chunk));
        const body = Buffer.concat(pending).subarray(VERSION.length);
        if (stage === "version" && Buffer.concat(pending).length >= VERSION.length) {
          socket.write(OFFER);
          stage = "select";
        }
        if (stage === "select" && body.length >= 1) {
          socket.write(challenge);
          stage = "response";
        }
        if (stage === "response" && body.length >= 17) {
          const ok = body.subarray(1, 17).equals(expectedResponse);
          const status = Buffer.alloc(4);
          if (!ok) {
            status.writeUInt32BE(1, 0);
            const reason = Buffer.from("password rejected");
            const length = Buffer.alloc(4);
            length.writeUInt32BE(reason.length, 0);
            socket.write(Buffer.concat([status, length, reason]));
            rejected += 1;
            settled = true;
            stage = "done";
            return;
          }
          socket.write(status);
          stage = "init";
        }
        if (stage === "init" && body.length >= 18) {
          const name = Buffer.from("desk");
          const init = Buffer.alloc(24 + name.length);
          init.writeUInt16BE(8, 0);
          init.writeUInt16BE(8, 2);
          init.writeUInt32BE(name.length, 20);
          name.copy(init, 24);
          socket.write(init);
          authenticated += 1;
          settled = true;
          stage = "done";
        }
      });
      socket.write(VERSION);
    });

    await expect(probe(port)).resolves.toEqual({ kind: "rfb", securityTypes: [2] });
    await vi.waitFor(() => expect(incomplete).toBe(1));
    expect(authenticated).toBe(0);

    await expect(
      probeRfbServer({ host: "127.0.0.1", port, timeoutMs: 2_000, vncPassword: password }),
    ).resolves.toEqual({ kind: "rfb", securityTypes: [2] });
    expect(authenticated).toBe(1);
    expect(incomplete).toBe(1);

    await expect(
      probeRfbServer({ host: "127.0.0.1", port, timeoutMs: 2_000, vncPassword: "wrongpwd" }),
    ).resolves.toEqual({ kind: "auth-rejected", reason: "password rejected" });
    expect(rejected).toBe(1);
    expect(incomplete).toBe(1);
  });

  it("returns a VncAuth rejection longer than 1 KiB", async () => {
    const reason = "x".repeat(1025);
    const port = await listenScriptedRfb((socket) => {
      const pending: Buffer[] = [];
      let stage = 0;
      socket.on("data", (chunk) => {
        pending.push(Buffer.from(chunk));
        const pendingBytes = Buffer.concat(pending);
        const body = pendingBytes.subarray(VERSION.length);
        if (stage === 0 && pendingBytes.length >= VERSION.length) {
          socket.write(OFFER);
          stage = 1;
        }
        if (stage === 1 && body.length >= 1) {
          socket.write(Buffer.alloc(16, 4));
          stage = 2;
        }
        if (stage === 2 && body.length >= 17) {
          const status = Buffer.alloc(4);
          status.writeUInt32BE(1, 0);
          const text = Buffer.from(reason);
          const length = Buffer.alloc(4);
          length.writeUInt32BE(text.length, 0);
          socket.write(Buffer.concat([status, length, text]));
          stage = 3;
        }
      });
      socket.write(VERSION);
    });
    await expect(
      probeRfbServer({ host: "127.0.0.1", port, timeoutMs: 2_000, vncPassword: "secret12" }),
    ).resolves.toEqual({ kind: "auth-rejected", reason });
  });
});

describe("RFB security classification", () => {
  it("classifies the first browser-supported security type in server preference order", () => {
    expect(classifyRfbSecurity([1])).toBe("none");
    expect(classifyRfbSecurity([30])).toBe("ard-account");
    expect(classifyRfbSecurity([19])).toBe("unsupported");
    expect(classifyRfbSecurity([30, 2])).toBe("ard-account");
    expect(classifyRfbSecurity([2, 30])).toBe("vnc-password");
    expect(classifyRfbSecurity([33, 2])).toBe("vnc-password");
    expect(classifyRfbSecurity([19, 2])).toBe("unsupported");
    expect(classifyRfbSecurity([30, 33, 36, 35])).toBe("ard-account");
  });
});

describe("retained RFB connection", () => {
  it.each([
    ["3.3", "RFB 003.003\n", "RFB 003.003\n", Buffer.from([0, 0, 0, 2])],
    ["3.7", "RFB 003.007\n", "RFB 003.007\n", Buffer.from([1, 2])],
    ["macOS", "RFB 003.889\n", "RFB 003.008\n", Buffer.from([2, 30, 2])],
  ])(
    "retains one %s connection across split replies and coalesced server data",
    async (_name, banner, reply, offer) => {
      const challenge = Buffer.alloc(16, 7);
      const clientData = Buffer.from([2, 8, 9]);
      const received: Buffer[] = [];
      let connections = 0;
      const port = await listenScriptedRfb((socket) => {
        connections++;
        socket.on("data", (data) => received.push(Buffer.from(data)));
        socket.write(Buffer.from(banner.slice(0, 5)));
        setImmediate(() => socket.write(Buffer.from(banner.slice(5))));
        socket.once("data", (version) => {
          expect(version).toEqual(Buffer.from(reply));
          socket.write(offer.subarray(0, 1));
          setTimeout(() => socket.write(Buffer.concat([offer.subarray(1), challenge])), 5);
        });
      });
      const stream = await connect(port, undefined, _name === "macOS" ? [30, 2] : [2]);
      const output: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => output.push(chunk));
      await vi.waitFor(() =>
        expect(Buffer.concat(output)).toEqual(
          Buffer.concat([Buffer.from(banner), offer, challenge]),
        ),
      );
      stream.write(Buffer.from(reply.slice(0, 4)));
      stream.write(Buffer.from(reply.slice(4, 9)));
      stream.write(Buffer.concat([Buffer.from(reply.slice(9)), clientData]));
      await vi.waitFor(() =>
        expect(Buffer.concat(received)).toEqual(Buffer.concat([Buffer.from(reply), clientData])),
      );
      expect(connections).toBe(1);
    },
  );

  it("rejects a changed downstream version without forwarding authentication bytes", async () => {
    const received: Buffer[] = [];
    const closed = createDeferred();
    const port = await listenScriptedRfb((socket) => {
      socket.once("close", () => closed.resolve());
      socket.on("data", (data) => received.push(Buffer.from(data)));
      serveHandshake(socket, () => {});
    });
    const stream = await connect(port);
    const failure = new Promise<Error>((resolve) => {
      stream.once("error", resolve);
    });
    stream.write(Buffer.from("RFB 003.003\nsecret-response"));
    await expect(failure).resolves.toMatchObject({
      message: "RFB client changed the inspected protocol version",
    });
    await closed.promise;
    expect(Buffer.concat(received)).toEqual(VERSION);
  });

  it.each(["banner", "security", "handoff"])(
    "cancels the owned socket during %s",
    async (phase) => {
      let connected = false;
      const closed = createDeferred();
      const port = await listenScriptedRfb((socket) => {
        connected = true;
        socket.once("close", () => closed.resolve());
        if (phase === "banner") {
          return;
        }
        socket.write(VERSION);
        socket.once("data", () => {
          if (phase === "handoff") {
            socket.write(OFFER);
          }
        });
      });
      const controller = new AbortController();
      const pending = connect(port, controller.signal);
      if (phase === "handoff") {
        const stream = await pending;
        controller.abort(new Error("desktop owner stopped"));
        await vi.waitFor(() => expect(stream.destroyed).toBe(true));
      } else {
        const rejected = expect(pending).rejects.toThrow("desktop owner stopped");
        await vi.waitFor(() => expect(connected).toBe(true));
        controller.abort(new Error("desktop owner stopped"));
        await rejected;
      }
      await closed.promise;
    },
  );
  it.each(["peer-fin", "owner-abort"])("settles queued client writes on %s", async (ending) => {
    const ready = createDeferred<net.Socket>();
    const peerClosed = createDeferred();
    const received: Buffer[] = [];
    let receivedBytes = 0;
    const response = Buffer.alloc(32 * 1024, 9);
    const port = await listenScriptedRfb((peer) => {
      peer.on("error", handlePeerTeardownError);
      peer.once("close", () => peerClosed.resolve());
      serveHandshake(peer, (selection) => {
        expect(selection).toEqual(Buffer.from([2]));
        peer.pause();
        peer.on("data", (chunk) => {
          const bytes = Buffer.from(chunk);
          received.push(bytes);
          receivedBytes += bytes.length;
        });
        ready.resolve(peer);
      });
    });
    const controller = new AbortController();
    const stream = await connect(port, controller.signal);
    const settled = finished(stream);
    void settled.catch(() => undefined);
    expect(await pauseAfterPrefix(stream)).toEqual(Buffer.concat([VERSION, OFFER]));
    stream.write(CLIENT_HELLO);
    const peer = await ready.promise;
    const first = Buffer.alloc(8 * 1024 * 1024, 7);
    const last = Buffer.from("queued-client-tail");
    const callbacks: Array<Error | null> = [];
    stream.write(first, (error) => callbacks.push(error ?? null));
    stream.write(last, (error) => callbacks.push(error ?? null));
    // Keep the first native write pending and the second queued in the wrapper
    // when FIN arrives. The same owner must drain both before ending TCP writes.
    expect(stream.writableLength).toBe(first.length + last.length);
    if (ending === "owner-abort") {
      controller.abort(new Error("desktop owner stopped"));
      await expect(settled).rejects.toThrow("desktop owner stopped");
      await vi.waitFor(() => expect(callbacks).toEqual([expect.any(Error), expect.any(Error)]));
      expect(stream.destroyed).toBe(true);
      return;
    }
    peer.end(response);
    await vi.waitFor(() => expect(stream.writableEnded).toBe(true));
    peer.resume();
    // Even after the peer closes, its terminal response survives until the paused reader drains.
    await peerClosed.promise;
    expect(stream).toMatchObject({ destroyed: false, writableEnded: true });
    const output: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => {
      output.push(chunk);
    });
    stream.resume();
    await expect(settled).resolves.toBeUndefined();
    expect(Buffer.concat(output)).toEqual(response);
    expect(callbacks).toEqual([null, null]);
    await vi.waitFor(() => expect(receivedBytes).toBe(first.length + last.length));
    expect(Buffer.concat(received).equals(Buffer.concat([first, last])), "queued bytes").toBe(true);
  });

  it.each(["", "final-pre-attach-response"])(
    "retains an offer and FIN before attachment (tail: %j)",
    async (tail) => {
      const finSent = createDeferred();
      const wire = Buffer.concat([VERSION, OFFER, Buffer.from(tail)]);
      const port = await listenScriptedRfb((peer) => {
        peer.write(wire.subarray(0, 12));
        peer.once("data", () => peer.end(wire.subarray(12), () => finSent.resolve()));
      });
      const stream = await connect(port);
      await finSent.promise;
      const settled = finished(stream);
      const received: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => {
        received.push(chunk);
      });
      stream.resume();
      await settled;
      expect(Buffer.concat(received)).toEqual(wire);
      expect(stream.writableFinished).toBe(true);
    },
  );
});
