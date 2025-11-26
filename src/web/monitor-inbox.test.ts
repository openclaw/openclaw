import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogger, setLoggerOverride } from "../logging.js";

vi.mock("../media/store.js", () => ({
  saveMediaBuffer: vi
    .fn()
    .mockResolvedValue({ id: "mid", path: "/tmp/mid", size: 1, contentType: "image/jpeg" }),
}));

vi.mock("./session.js", () => {
  const { EventEmitter } = require("node:events");
  const ev = new EventEmitter();
  const sock = {
    ev,
    ws: { close: vi.fn() },
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    readMessages: vi.fn().mockResolvedValue(undefined),
    updateMediaMessage: vi.fn(),
    logger: {},
    user: { id: "[redacted-email]" },
  };
  return {
    createWaSocket: vi.fn().mockResolvedValue(sock),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
    getStatusCode: vi.fn(() => 500),
  };
});

import { monitorWebInbox } from "./inbound.js";
const { createWaSocket } = await import("./session.js");
const getSock = () => (createWaSocket as unknown as () => Promise<ReturnType<typeof mockSock>>)();
import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogger, setLoggerOverride } from "../logging.js";
import { monitorWebInbox } from "./inbound.js";

describe("web monitor inbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
  });

  it("streams inbound messages", async () => {
    const onMessage = vi.fn(async (msg) => {
      await msg.sendComposing();
      await msg.reply("pong");
    });

    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("available");
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "abc", fromMe: false, remoteJid: "[redacted-email]" },
          message: { conversation: "ping" },
          messageTimestamp: 1_700_000_000,
          pushName: "Tester",
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "ping", from: "+999", to: "+123" }),
    );
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "[redacted-email]",
        id: "abc",
        participant: undefined,
        fromMe: false,
      },
    ]);
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("available");
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith(
      "composing",
      "[redacted-email]",
    );
    expect(sock.sendMessage).toHaveBeenCalledWith("[redacted-email]", {
      text: "pong",
    });

    await listener.close();
  });

  it("captures media path for image messages", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "med1", fromMe: false, remoteJid: "[redacted-email]" },
          message: { imageMessage: { mimetype: "image/jpeg" } },
          messageTimestamp: 1_700_000_100,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "<media:image>",
      }),
    );
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "[redacted-email]",
        id: "med1",
        participant: undefined,
        fromMe: false,
      },
    ]);
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith("available");
    await listener.close();
  });

  it("resolves onClose when the socket closes", async () => {
    const listener = await monitorWebInbox({
      verbose: false,
      onMessage: vi.fn(),
    });
    const sock = await createWaSocket();
    const reasonPromise = listener.onClose;
    sock.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });
    await expect(reasonPromise).resolves.toEqual(
      expect.objectContaining({ status: 500, isLoggedOut: false }),
    );
    await listener.close();
  });

  it("logs inbound bodies to file", async () => {
    const logPath = path.join(
      os.tmpdir(),
      `warelay-log-test-${crypto.randomUUID()}.log`,
    );
    setLoggerOverride({ level: "trace", file: logPath });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "abc", fromMe: false, remoteJid: "[redacted-email]" },
          message: { conversation: "ping" },
          messageTimestamp: 1_700_000_000,
          pushName: "Tester",
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    const content = fsSync.readFileSync(logPath, "utf-8");
    expect(content).toContain('"module":"web-inbound"');
    expect(content).toContain('"body":"ping"');
    await listener.close();
  });

  it("includes participant when marking group messages read", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = await createWaSocket();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "grp1",
            fromMe: false,
            remoteJid: "[redacted-email]",
            participant: "[redacted-email]",
          },
          message: { conversation: "group ping" },
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "[redacted-email]",
        id: "grp1",
        participant: "[redacted-email]",
        fromMe: false,
      },
    ]);
    await listener.close();
  });
});
