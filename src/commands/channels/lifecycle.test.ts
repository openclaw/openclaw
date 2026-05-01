import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelsLifecycleCommand } from "./lifecycle.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

describe("channelsLifecycleCommand", () => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callGateway.mockResolvedValue({
      channel: "whatsapp",
      accountId: "acct-1",
      started: true,
    });
  });

  it("calls channels.start with channel and account id", async () => {
    await channelsLifecycleCommand(
      "start",
      { channel: " whatsapp ", account: " acct-1 " },
      runtime as never,
    );

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "channels.start",
      params: {
        channel: "whatsapp",
        accountId: "acct-1",
      },
    });
    expect(runtime.log).toHaveBeenCalledWith("Started whatsapp/acct-1.");
  });

  it("calls channels.stop without account id when omitted", async () => {
    mocks.callGateway.mockResolvedValueOnce({
      channel: "whatsapp",
      accountId: "default",
      stopped: true,
    });

    await channelsLifecycleCommand("stop", { channel: "whatsapp" }, runtime as never);

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "channels.stop",
      params: {
        channel: "whatsapp",
      },
    });
    expect(runtime.log).toHaveBeenCalledWith("Stopped whatsapp/default.");
  });

  it("calls channels.restart and supports JSON output", async () => {
    const payload = {
      channel: "whatsapp",
      accountId: "acct-1",
      stopped: true,
      started: true,
    };
    mocks.callGateway.mockResolvedValueOnce(payload);

    await channelsLifecycleCommand(
      "restart",
      { channel: "whatsapp", account: "acct-1", json: true },
      runtime as never,
    );

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "channels.restart",
      params: {
        channel: "whatsapp",
        accountId: "acct-1",
      },
    });
    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Restarted"));
  });

  it("does not report restart success when the stop phase failed", async () => {
    mocks.callGateway.mockResolvedValueOnce({
      channel: "whatsapp",
      accountId: "acct-1",
      stopped: false,
      started: true,
    });

    await channelsLifecycleCommand(
      "restart",
      { channel: "whatsapp", account: "acct-1" },
      runtime as never,
    );

    expect(runtime.log).toHaveBeenCalledWith(
      "Restart requested for whatsapp/acct-1, but the stop phase did not complete.",
    );
  });

  it("rejects missing channel before calling the Gateway", async () => {
    await expect(channelsLifecycleCommand("start", {}, runtime as never)).rejects.toThrow(
      "Channel is required (--channel <name>).",
    );
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });
});
