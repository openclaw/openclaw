import dgram from "node:dgram";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendNotification, notifyReady, notifyWatchdog } from "./systemd-notify.js";

vi.mock("node:dgram", () => {
  const mockSocket = {
    send: vi.fn((buffer, offset, length, path, callback) => {
      if (callback) callback();
    }),
    close: vi.fn(),
  };
  return {
    default: {
      createSocket: vi.fn(() => mockSocket),
    },
  };
});

describe("systemd-notify", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("should not send notification if NOTIFY_SOCKET is not set", () => {
    delete process.env.NOTIFY_SOCKET;
    sendNotification("READY=1");
    expect(dgram.createSocket).not.toHaveBeenCalled();
  });

  it("should send notification if NOTIFY_SOCKET is set", () => {
    process.env.NOTIFY_SOCKET = "/tmp/test.sock";
    sendNotification("READY=1");

    expect(dgram.createSocket).toHaveBeenCalledWith("unix_dgram");
    const socket = dgram.createSocket("unix_dgram");
    expect(socket.send).toHaveBeenCalled();
    const [buffer, offset, length, path] = (socket.send as any).mock.calls[0];
    expect(buffer.toString()).toBe("READY=1\n");
    expect(path).toBe("/tmp/test.sock");
  });

  it("should handle abstract namespace sockets (starting with @)", () => {
    process.env.NOTIFY_SOCKET = "@/test/abstract.sock";
    sendNotification("READY=1");

    const socket = dgram.createSocket("unix_dgram");
    const [buffer, offset, length, path] = (socket.send as any).mock.calls[0];
    expect(path).toBe("\0/test/abstract.sock");
  });

  it("notifyReady should send READY=1", () => {
    process.env.NOTIFY_SOCKET = "/tmp/test.sock";
    notifyReady();
    const socket = dgram.createSocket("unix_dgram");
    const [buffer] = (socket.send as any).mock.calls[0];
    expect(buffer.toString()).toBe("READY=1\n");
  });

  it("notifyWatchdog should send WATCHDOG=1", () => {
    process.env.NOTIFY_SOCKET = "/tmp/test.sock";
    notifyWatchdog();
    const socket = dgram.createSocket("unix_dgram");
    const [buffer] = (socket.send as any).mock.calls[0];
    expect(buffer.toString()).toBe("WATCHDOG=1\n");
  });
});
