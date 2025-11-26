import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetLogger, setLoggerOverride } from "../logging.js";

vi.mock("./session.js", () => {
  const { EventEmitter } = require("node:events");
  const ev = new EventEmitter();
  const sock = {
    ev,
    ws: { close: vi.fn() },
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ key: { id: "msg123" } }),
  };
  return {
    createWaSocket: vi.fn().mockResolvedValue(sock),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
  };
});

import { sendMessageWeb } from "./outbound.js";
const { createWaSocket } = await import("./session.js");

describe("web outbound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
  });

  it("sends message via web and closes socket", async () => {
    await sendMessageWeb("+1555", "hi", { verbose: false });
    const sock = await createWaSocket();
    expect(sock.sendMessage).toHaveBeenCalled();
    expect(sock.ws.close).toHaveBeenCalled();
  });
});
