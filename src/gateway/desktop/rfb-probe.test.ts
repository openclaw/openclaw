import net from "node:net";
import type { Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { closeServer, listenLoopback } from "./desktop.test-support.js";
import { classifyRfbSecurity, connectRfbServer, probeRfbServer } from "./rfb-probe.js";

const cleanups: Array<() => Promise<void>> = [];
const VERSION = Buffer.from("RFB 003.008\n");
const OFFER = Buffer.from([1, 2]);
const CLIENT_HELLO = Buffer.concat([VERSION, Buffer.from([2])]);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Serves one scripted RFB handshake so probes exercise the real socket reader. */
async function listenScriptedRfb(script: (socket: net.Socket) => void): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    script(socket);
  });
  const port = await listenLoopback(server);
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await closeServer(server);
  });
  return port;
}

function probe(port: number) {
  return probeRfbServer({ host: "127.0.0.1", port, timeoutMs: 2_000 });
}

async function connect(port: number, signal?: AbortSignal) {
  const result = await connectRfbServer({ host: "127.0.0.1", port, timeoutMs: 2_000, signal });
  expect(result.kind).toBe("rfb");
  if (result.kind !== "rfb") {
    throw new Error("expected retained connection");
  }
  cleanups.push(async () => {
    result.stream.destroy();
  });
  return result;
}

function serveHandshake(socket: net.Socket, onSelection: (selection: Buffer) => void) {
  socket.write(VERSION);
  socket.once("data", () => {
    socket.write(OFFER);
    socket.once("data", onSelection);
  });
}

async function collect(stream: Duplex) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("RFB server probe", () => {
  it("reassembles a handshake split across packets", async () => {
    const port = await listenScriptedRfb((socket) => {
      socket.write(Buffer.from("RFB 003", "ascii"));
      setTimeout(() => socket.write(Buffer.from(".008\n", "ascii")), 5);
      socket.once("data", () => {
        socket.write(Buffer.from([2]));
        setTimeout(() => socket.write(Buffer.from([2, 30])), 5);
      });
    });
    await expect(probe(port)).resolves.toEqual({ kind: "rfb", securityTypes: [2, 30] });
  });

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
    await expect(probeRfbServer({ host: "127.0.0.1", port, timeoutMs: 50 })).resolves.toEqual({
      kind: "timeout",
    });
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
          socket.write(Buffer.concat([offer, challenge]));
        });
      });
      const result = await connect(port);
      const output: Buffer[] = [];
      result.stream.on("data", (chunk: Buffer) => output.push(chunk));
      await vi.waitFor(() =>
        expect(Buffer.concat(output)).toEqual(
          Buffer.concat([Buffer.from(banner), offer, challenge]),
        ),
      );
      result.stream.write(Buffer.from(reply.slice(0, 4)));
      result.stream.write(Buffer.from(reply.slice(4, 9)));
      result.stream.write(Buffer.concat([Buffer.from(reply.slice(9)), clientData]));
      await vi.waitFor(() =>
        expect(Buffer.concat(received)).toEqual(Buffer.concat([Buffer.from(reply), clientData])),
      );
      expect(connections).toBe(1);
    },
  );

  it("rejects a changed downstream version without forwarding authentication bytes", async () => {
    const received: Buffer[] = [];
    let closed = false;
    const port = await listenScriptedRfb((socket) => {
      socket.once("close", () => {
        closed = true;
      });
      socket.on("data", (data) => received.push(Buffer.from(data)));
      socket.write(Buffer.from("RFB 003.008\n"));
      socket.once("data", () => socket.write(Buffer.from([1, 2])));
    });
    const result = await connect(port);
    const failure = new Promise<Error>((resolve) => {
      result.stream.once("error", resolve);
    });
    result.stream.write(Buffer.from("RFB 003.003\nsecret-response"));
    await expect(failure).resolves.toMatchObject({
      message: "RFB client changed the inspected protocol version",
    });
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(Buffer.concat(received)).toEqual(Buffer.from("RFB 003.008\n"));
  });

  it.each(["banner", "security", "handoff"])(
    "cancels the owned socket during %s",
    async (phase) => {
      let connected = false;
      let closed = false;
      const port = await listenScriptedRfb((socket) => {
        connected = true;
        socket.once("close", () => {
          closed = true;
        });
        if (phase === "banner") {
          return;
        }
        socket.write(Buffer.from("RFB 003.008\n"));
        socket.once("data", () => {
          if (phase === "handoff") {
            socket.write(Buffer.from([1, 2]));
          }
        });
      });
      const controller = new AbortController();
      const pending = connectRfbServer({
        host: "127.0.0.1",
        port,
        timeoutMs: 2_000,
        signal: controller.signal,
      });
      if (phase === "handoff") {
        const result = await pending;
        if (result.kind !== "rfb") {
          throw new Error("expected retained connection");
        }
        controller.abort(new Error("desktop owner stopped"));
        await vi.waitFor(() => expect(result.stream.destroyed).toBe(true));
      } else {
        const rejected = expect(pending).rejects.toThrow("desktop owner stopped");
        await vi.waitFor(() => expect(connected).toBe(true));
        controller.abort(new Error("desktop owner stopped"));
        await rejected;
      }
      await vi.waitFor(() => expect(closed).toBe(true));
    },
  );
  it("ends writes and preserves terminal response bytes while a consumer remains paused", async () => {
    const response = Buffer.alloc(32 * 1024, 7);
    const peerClosed = createDeferred();
    const port = await listenScriptedRfb((socket) => {
      socket.once("close", () => peerClosed.resolve());
      serveHandshake(socket, (selection) => {
        expect(selection).toEqual(Buffer.from([2]));
        socket.end(response);
      });
    });
    const result = await connect(port);
    const prefix = await new Promise<Buffer>((resolve) => {
      result.stream.once("data", (chunk: Buffer) => {
        result.stream.pause();
        resolve(chunk);
      });
    });
    expect(prefix).toEqual(Buffer.concat([VERSION, OFFER]));
    result.stream.write(CLIENT_HELLO);
    // The peer has finished and closed while the caller has consumed no response.
    await peerClosed.promise;
    expect(result.stream).toMatchObject({ destroyed: false, writableEnded: true });
    const settled = finished(result.stream);
    void settled.catch(() => undefined);
    expect(await collect(result.stream)).toEqual(response);
    await expect(settled).resolves.toBeUndefined();
  });

  it.each(["peer-fin", "owner-abort"])("settles queued client writes on %s", async (ending) => {
    const ready = createDeferred<net.Socket>();
    const received: Buffer[] = [];
    let receivedBytes = 0;
    const response = Buffer.alloc(32 * 1024, 9);
    const port = await listenScriptedRfb((peer) => {
      peer.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
          throw error;
        }
      });
      serveHandshake(peer, () => {
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
    const result = await connect(port, controller.signal);
    const settled = finished(result.stream);
    void settled.catch(() => undefined);
    await new Promise<void>((resolve) => {
      result.stream.once("data", () => {
        result.stream.pause();
        resolve();
      });
    });
    result.stream.write(CLIENT_HELLO);
    const peer = await ready.promise;
    const first = Buffer.alloc(8 * 1024 * 1024, 7);
    const last = Buffer.from("queued-client-tail");
    const callbacks: Array<Error | null> = [];
    result.stream.write(first, (error) => callbacks.push(error ?? null));
    result.stream.write(last, (error) => callbacks.push(error ?? null));
    // Keep the first native write pending and the second queued in the wrapper
    // when FIN arrives. The same owner must drain both before ending TCP writes.
    expect(result.stream.writableLength).toBe(first.length + last.length);
    if (ending === "owner-abort") {
      controller.abort(new Error("desktop owner stopped"));
      await expect(settled).rejects.toThrow("desktop owner stopped");
      await vi.waitFor(() => expect(callbacks).toHaveLength(2));
      expect(callbacks.every((error) => error instanceof Error)).toBe(true);
      expect(result.stream.destroyed).toBe(true);
      return;
    }
    peer.end(response);
    await vi.waitFor(() => expect(result.stream.writableEnded).toBe(true));
    peer.resume();
    const output: Buffer[] = [];
    result.stream.on("data", (chunk: Buffer) => output.push(chunk));
    result.stream.resume();
    await expect(settled).resolves.toBeUndefined();
    expect(Buffer.concat(output)).toEqual(response);
    expect(callbacks).toEqual([null, null]);
    await vi.waitFor(() => expect(receivedBytes).toBe(first.length + last.length));
    expect(Buffer.concat(received).equals(Buffer.concat([first, last]))).toBe(true);
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
      const result = await connect(port);
      await finSent.promise;
      const settled = finished(result.stream);
      const received = collect(result.stream);
      await settled;
      expect(await received).toEqual(wire);
      expect(result.stream.writableFinished).toBe(true);
    },
  );
});
