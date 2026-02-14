import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import "./monitor-inbox.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { setLoggerOverride } from "../logging.js";
import { monitorWebInbox } from "./inbound.js";
import {
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
} from "./monitor-inbox.test-harness.js";

describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  it("captures media path for image messages", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = getSock();
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

  it("sets gifPlayback on outbound video payloads when requested", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = getSock();
    const buf = Buffer.from("gifvid");

    await listener.sendMessage("+1555", "gif", buf, "video/mp4", {
      gifPlayback: true,
    });

    expect(sock.sendMessage).toHaveBeenCalledWith("[redacted-email]", {
      video: buf,
      caption: "gif",
      mimetype: "video/mp4",
      gifPlayback: true,
    });

    await listener.close();
  });

  it("resolves onClose when the socket closes", async () => {
    const listener = await monitorWebInbox({
      verbose: false,
      onMessage: vi.fn(),
    });
    const sock = getSock();
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
    const logPath = path.join(os.tmpdir(), `openclaw-log-test-${crypto.randomUUID()}.log`);
    setLoggerOverride({ level: "trace", file: logPath });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = getSock();
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
    expect(content).toMatch(/web-inbound/);
    expect(content).toMatch(/ping/);
    await listener.close();
  });

  it("includes participant when marking group messages read", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = getSock();
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

  it("passes through group messages with participant metadata", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = getSock();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "grp2",
            fromMe: false,
            remoteJid: "[redacted-email]",
            participant: "[redacted-email]",
          },
          pushName: "Alice",
          message: {
            extendedTextMessage: {
              text: "@bot ping",
              contextInfo: { mentionedJid: ["[redacted-email]"] },
            },
          },
          messageTimestamp: 1_700_000_000,
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatType: "group",
        conversationId: "[redacted-email]",
        senderE164: "+777",
        mentionedJids: ["[redacted-email]"],
      }),
    );
    await listener.close();
  });

  it("unwraps ephemeral messages, preserves mentions, and still delivers group pings", async () => {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = getSock();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "grp-ephem",
            fromMe: false,
            remoteJid: "[redacted-email]",
            participant: "[redacted-email]",
          },
          message: {
            ephemeralMessage: {
              message: {
                extendedTextMessage: {
                  text: "oh hey @Clawd UK !",
                  contextInfo: { mentionedJid: ["[redacted-email]"] },
                },
              },
            },
          },
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatType: "group",
        conversationId: "[redacted-email]",
        body: "oh hey @Clawd UK !",
        mentionedJids: ["[redacted-email]"],
        senderE164: "+888",
      }),
    );

    await listener.close();
  });

  it("still forwards group messages (with sender info) even when allowFrom is restrictive", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          // does not include +777
          allowFrom: ["+111"],
          groupPolicy: "open",
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    const onMessage = vi.fn();
    const listener = await monitorWebInbox({ verbose: false, onMessage });
    const sock = getSock();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: {
            id: "grp-allow",
            fromMe: false,
            remoteJid: "[redacted-email]",
            participant: "[redacted-email]",
          },
          message: {
            extendedTextMessage: {
              text: "@bot hi",
              contextInfo: { mentionedJid: ["[redacted-email]"] },
            },
          },
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatType: "group",
        from: "[redacted-email]",
        senderE164: "+777",
        senderJid: "[redacted-email]",
        mentionedJids: ["[redacted-email]"],
        selfE164: "+123",
        selfJid: "[redacted-email]",
      }),
    );

    await listener.close();
  });
});
