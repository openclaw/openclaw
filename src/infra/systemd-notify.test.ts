import dgram from "node:dgram";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendNotification, notifyReady, notifyWatchdog } from "./systemd-notify.js";

const { mockSend, mockClose } = vi.hoisted(() => ({
  mockSend: vi.fn(
    (
      _buffer: Buffer | string | Uint8Array,
      _offset: number,
      _length: number,
      _path: string | number,
      callback?: (err: Error | null) => void,
    ) => {
      if (callback) {
        callback(null);
      }
    },
  ),
  mockClose: vi.fn(),
}));

vi.mock("node:dgram", () => ({
  default: {
    createSocket: vi.fn(() => ({ send: mockSend, close: mockClose })),
  },
}));

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
    expect(mockSend).toHaveBeenCalled();
    const [buffer, _offset, _length, path] = mockSend.mock.calls[0];
    expect(String(buffer)).toBe("READY=1\n");
    expect(path).toBe("/tmp/test.sock");
  });

  it("should handle abstract namespace sockets (starting with @)", () => {
    process.env.NOTIFY_SOCKET = "@/test/abstract.sock";
    sendNotification("READY=1");

    const [_buffer, _offset, _length, path] = mockSend.mock.calls[0];
    expect(path).toBe("\0/test/abstract.sock");
  });

  it("notifyReady should send READY=1", () => {
    process.env.NOTIFY_SOCKET = "/tmp/test.sock";
    notifyReady();
    const [buffer] = mockSend.mock.calls[0];
    expect(String(buffer)).toBe("READY=1\n");
  });

  it("notifyWatchdog should send WATCHDOG=1", () => {
    process.env.NOTIFY_SOCKET = "/tmp/test.sock";
    notifyWatchdog();
    const [buffer] = mockSend.mock.calls[0];
    expect(String(buffer)).toBe("WATCHDOG=1\n");
  });
});
