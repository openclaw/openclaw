import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  expectUnauthorizedUpgrade,
  closeServer,
  listenLoopback,
  setupDesktopDiagnostics,
  waitForClose,
} from "./desktop.test-support.js";
import { createNodeDesktopStreamBroker } from "./node-stream-broker.js";

const cleanups: Array<() => Promise<void>> = [];
const captureLogs = setupDesktopDiagnostics(cleanups, "node-stream-broker-diagnostics-");

async function createBrokerFixture(pairingCurrent?: () => boolean | Promise<boolean>) {
  const broker = createNodeDesktopStreamBroker();
  const session = { connId: "conn-1", pairingGeneration: "generation-1" };
  const registry = {
    getForPairingGeneration: (_nodeId: string, pairingGeneration: string) =>
      pairingGeneration === session.pairingGeneration ? { connId: session.connId } : undefined,
    isConnectionCurrentPairingState: async (connId: string) =>
      connId === session.connId && (await (pairingCurrent?.() ?? true)),
  };
  const server = http.createServer();
  const upgradedSocketsClosed: Promise<void>[] = [];
  server.on("upgrade", (req, socket, head) => {
    upgradedSocketsClosed.push(waitForClose(socket));
    void broker.handleUpgrade(req, socket, head, registry as never);
  });
  const port = await listenLoopback(server);
  cleanups.push(async () => {
    await closeServer(server);
    // HTTP close excludes upgraded sockets; their late diagnostics belong to this test.
    await Promise.all(upgradedSocketsClosed);
  });
  return { broker, session, baseUrl: `ws://127.0.0.1:${port}` };
}

async function openSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  cleanups.push(async () => ws.terminate());
  await once(ws, "open");
  return ws;
}

async function connectAndSend(url: string, metadata: object): Promise<WebSocket> {
  const ws = await openSocket(url);
  ws.send(Buffer.from(JSON.stringify(metadata)), { binary: true });
  return ws;
}

const expectUnauthorized = (url: string) => expectUnauthorizedUpgrade(url, cleanups);

async function pendingPairingHandoff() {
  let pairingChecks = 0;
  const { promise: recheck, resolve: releaseRecheck } = createDeferred();
  const { broker, session, baseUrl } = await createBrokerFixture(async () => {
    if (++pairingChecks > 1) {
      await recheck;
    }
    return true;
  });
  const minted = broker.mint({ nodeId: "node-1", ...session });
  const ws = await connectAndSend(`${baseUrl}${minted.attachPath}`, { auth: "vnc-password" });
  return { minted, ws, releaseRecheck, checks: () => pairingChecks };
}

describe("node desktop stream tickets", () => {
  it.each([
    { kind: "desktop", closeMode: "peer-close" },
    { kind: "portal", closeMode: "consumer-destroy" },
  ] as const)(
    "keeps idle $kind streams alive through remote backpressure and records $closeMode",
    async ({ kind, closeMode }) => {
      const logCapture = captureLogs();
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const { broker, session, baseUrl } = await createBrokerFixture();
      const serverTimers = vi.getTimerCount();
      const binding = { nodeId: "node-1", ...session };
      const minted = kind === "desktop" ? broker.mint(binding) : broker.mintPortal(binding);
      const ws = await connectAndSend(
        `${baseUrl}${minted.attachPath}`,
        kind === "desktop" ? { auth: "vnc-password" } : { ok: true },
      );
      const { stream } = await minted.attached;
      expect(vi.getTimerCount()).toBe(serverTimers + 1);
      const pings: Buffer[] = [];
      const streamBytes: Buffer[] = [];
      ws.on("ping", (data) => pings.push(data));
      stream.on("data", (data) => streamBytes.push(data));

      vi.advanceTimersByTime(25_000);
      await expect.poll(() => pings.length).toBe(1);
      expect(streamBytes).toEqual([]);

      // A paused remote peer cannot process pings or send automatic pongs.
      ws.pause();
      vi.advanceTimersByTime(50_000);
      ws.resume();
      await expect.poll(() => pings.length).toBe(3);
      ws.send(Buffer.from("resumed stream bytes"), { binary: true });
      await expect.poll(() => Buffer.concat(streamBytes).toString()).toBe("resumed stream bytes");
      expect(ws.readyState).toBe(WebSocket.OPEN);

      const closed = waitForClose(ws);
      const streamClosed = waitForClose(stream);
      if (closeMode === "peer-close") {
        ws.close(1012, `peer restart\n${minted.attachPath}`);
      } else {
        stream.destroy();
      }
      await Promise.all([closed, streamClosed]);
      await logCapture.flush();
      const records = logCapture.records.filter(
        (record) => record.message === "node stream closed",
      );
      expect(records).toHaveLength(1);
      expect(records[0]?.attributes).toMatchObject({
        streamKind: kind,
        nodeId: "node-1",
        connId: "conn-1",
        trigger: "websocket-close",
        closeCode: closeMode === "peer-close" ? 1012 : 1006,
      });
      expect(records[0]?.attributes?.closeReason).toBeUndefined();
      const serialized = JSON.stringify(logCapture.records);
      expect(serialized).not.toContain("peer restart");
      expect(serialized).not.toContain(minted.ticket);
      expect(serialized).not.toContain(minted.attachPath);
      expect(serialized).not.toContain("resumed stream bytes");
      vi.advanceTimersByTime(25_000);
      expect(pings).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(serverTimers);
    },
  );

  it.each([
    { auth: "vnc-password", vncPassword: undefined },
    { auth: "ard-account", vncPassword: "synthetic-desktop-password" },
  ] as const)(
    "is single-use and resolves one ticket-bound $auth stream with password $vncPassword",
    async ({ auth, vncPassword }) => {
      const { broker, session, baseUrl } = await createBrokerFixture();
      const minted = broker.mint({ nodeId: "node-1", ...session });

      const metadata = { auth, ...(vncPassword ? { vncPassword } : {}) };
      await connectAndSend(`${baseUrl}${minted.attachPath}`, metadata);
      const attached = await minted.attached;
      expect(attached).toMatchObject(metadata);
      expect(attached.vncPassword).toBe(vncPassword);
      attached.stream.destroy();

      await expectUnauthorized(`${baseUrl}${minted.attachPath}`);
    },
  );

  it("buffers early RFB bytes while the pairing binding is rechecked", async () => {
    const { minted, ws, releaseRecheck, checks } = await pendingPairingHandoff();
    const earlyBanner = Buffer.from("RFB 003.008\n", "ascii");
    ws.send(earlyBanner, { binary: true });
    await vi.waitFor(() => expect(checks()).toBe(2));
    releaseRecheck();

    const attached = await minted.attached;
    await expect(
      new Promise<Buffer>((resolve) => {
        attached.stream.once("data", resolve);
      }),
    ).resolves.toEqual(earlyBanner);
    attached.stream.destroy();
  });

  it("rejects a stream error during the asynchronous pairing handoff", async () => {
    const { minted, ws, releaseRecheck, checks } = await pendingPairingHandoff();
    await vi.waitFor(() => expect(checks()).toBe(2));
    ws.send(Buffer.alloc(65 * 1024), { binary: true });

    await expect(minted.attached).rejects.toThrow();
    releaseRecheck();
  });

  it.each([
    { auth: "none" },
    { auth: "vnc-password", vncPassword: 42 },
    { auth: "ard-account", vncPassword: "secret", username: "worker" },
    { auth: "ard-account", vncPassword: "x".repeat(64) },
  ])("rejects invalid metadata %j without exposing later WebSocket errors", async (metadata) => {
    const { broker, session, baseUrl } = await createBrokerFixture();
    const minted = broker.mint({ nodeId: "node-1", ...session });
    const ws = await connectAndSend(`${baseUrl}${minted.attachPath}`, metadata);
    ws.send(Buffer.alloc(65 * 1024), { binary: true });

    await expect(minted.attached).rejects.toThrow();
  });

  it("rejects an expired ticket before upgrading", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { broker, session, baseUrl } = await createBrokerFixture();
    const minted = broker.mint({ nodeId: "node-1", ...session });
    now.mockReturnValue(minted.expiresAtMs);

    await expectUnauthorized(`${baseUrl}${minted.attachPath}`);
    await expect(minted.attached).rejects.toThrow("expired");
  });

  it("rejects a ticket after connection or pairing generation replacement", async () => {
    const { broker, session, baseUrl } = await createBrokerFixture();
    const oldConnection = broker.mint({ nodeId: "node-1", ...session });
    session.connId = "conn-2";
    await expectUnauthorized(`${baseUrl}${oldConnection.attachPath}`);
    await expect(oldConnection.attached).rejects.toThrow("stale");

    const oldGeneration = broker.mint({ nodeId: "node-1", ...session });
    session.pairingGeneration = "generation-2";
    await expectUnauthorized(`${baseUrl}${oldGeneration.attachPath}`);
    await expect(oldGeneration.attached).rejects.toThrow("stale");
  });

  it("rechecks the pairing generation after a delayed metadata frame", async () => {
    const { broker, session, baseUrl } = await createBrokerFixture();
    const minted = broker.mint({ nodeId: "node-1", ...session });
    const ws = await openSocket(`${baseUrl}${minted.attachPath}`);
    session.pairingGeneration = "generation-2";
    ws.send(Buffer.from(JSON.stringify({ auth: "vnc-password" })), { binary: true });

    await expect(minted.attached).rejects.toThrow("stale");
  });

  it.each(["cancelled", "expired"] as const)(
    "rejects a redeemed ticket that is %s while metadata is pending",
    async (outcome) => {
      const logCapture = captureLogs();
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const { broker, session, baseUrl } = await createBrokerFixture();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const minted = broker.mint({ nodeId: "node-1", ...session });
      const ws = await openSocket(`${baseUrl}${minted.attachPath}`);
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      if (outcome === "cancelled") {
        minted.cancel();
      } else {
        vi.advanceTimersByTime(60_000);
      }

      await expect(minted.attached).rejects.toThrow(`node desktop stream ticket ${outcome}`);
      await expect(closed).resolves.toEqual({ code: 1008, reason: "node desktop attach rejected" });
      vi.useRealTimers();
      now.mockRestore();
      await expect
        .poll(async () => {
          await logCapture.flush();
          return logCapture.records.filter((record) => record.message === "node stream closed");
        })
        .toHaveLength(1);
      expect(logCapture.records[0]?.attributes).toMatchObject({
        trigger: "attach-rejected",
        closeCode: 1008,
      });
    },
  );

  it("rejects when the raw upgrade socket closes during pairing authorization", async () => {
    let pairingChecks = 0;
    const { promise: check, resolve: releaseCheck } = createDeferred();
    const { broker, session, baseUrl } = await createBrokerFixture(async () => {
      pairingChecks += 1;
      await check;
      return true;
    });
    const minted = broker.mint({ nodeId: "node-1", ...session });
    const url = new URL(baseUrl);
    const socket = net.createConnection(Number(url.port), url.hostname);
    cleanups.push(async () => {
      socket.destroy();
    });
    await once(socket, "connect");
    socket.write(
      [
        `GET ${minted.attachPath} HTTP/1.1`,
        `Host: ${url.host}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGVzdC1ub25jZS0xMjM0NQ==",
        "",
        "",
      ].join("\r\n"),
    );
    await vi.waitFor(() => expect(pairingChecks).toBe(1));

    socket.destroy();

    await expect(minted.attached).rejects.toThrow("authorization");
    releaseCheck();
  });
});

describe("node portal stream tickets", () => {
  it("pairs a ready portal stream and keeps desktop and portal tickets isolated", async () => {
    const { broker, session, baseUrl } = await createBrokerFixture();
    const minted = broker.mintPortal({ nodeId: "node-1", ...session });

    await expectUnauthorized(
      `${baseUrl}${minted.attachPath.replace("/node-portal/", "/node-desktop/")}`,
    );
    const ws = await connectAndSend(`${baseUrl}${minted.attachPath}`, { ok: true });
    const attached = await minted.attached;
    const response = new Promise<Buffer>((resolve) => {
      attached.stream.once("data", resolve);
    });
    ws.send(Buffer.from("HTTP/1.1 200 OK\r\n\r\n"), { binary: true });

    await expect(response).resolves.toEqual(Buffer.from("HTTP/1.1 200 OK\r\n\r\n"));
    attached.stream.destroy();
    await expectUnauthorized(`${baseUrl}${minted.attachPath}`);
  });

  it("rejects unexpected portal readiness metadata", async () => {
    const { broker, session, baseUrl } = await createBrokerFixture();
    const minted = broker.mintPortal({ nodeId: "node-1", ...session });

    await connectAndSend(`${baseUrl}${minted.attachPath}`, { ok: true, auth: "vnc-password" });

    await expect(minted.attached).rejects.toThrow("invalid node portal attach metadata");
  });

  it("rejects immediately when the node closes before the target is ready", async () => {
    const { broker, session, baseUrl } = await createBrokerFixture();
    const minted = broker.mintPortal({ nodeId: "node-1", ...session });
    const ws = await openSocket(`${baseUrl}${minted.attachPath}`);

    ws.close();

    await expect(minted.attached).rejects.toThrow("node portal stream closed before attach");
  });
});
