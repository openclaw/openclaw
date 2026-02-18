import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const callGateway = vi.fn();
const withProgress = vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => await fn());
const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../gateway/call.js", () => ({
  callGateway,
}));

vi.mock("./progress.js", () => ({
  withProgress,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

async function runDevicesApprove(argv: string[]) {
  const { registerDevicesCli } = await import("./devices-cli.js");
  const program = new Command();
  registerDevicesCli(program);
  await program.parseAsync(["devices", "approve", ...argv], { from: "user" });
}

async function runDevicesCommand(argv: string[]) {
  const { registerDevicesCli } = await import("./devices-cli.js");
  const program = new Command();
  registerDevicesCli(program);
  await program.parseAsync(["devices", ...argv], { from: "user" });
}

describe("devices cli approve", () => {
  afterEach(() => {
    callGateway.mockReset();
    withProgress.mockClear();
    runtime.log.mockReset();
    runtime.error.mockReset();
    runtime.exit.mockReset();
  });

  it("approves an explicit request id without listing", async () => {
    callGateway.mockResolvedValueOnce({ device: { deviceId: "device-1" } });

    await runDevicesApprove(["req-123"]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "device.pair.approve",
        params: { requestId: "req-123" },
      }),
    );
  });

  it("auto-approves the latest pending request when id is omitted", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [
          { requestId: "req-1", ts: 1000 },
          { requestId: "req-2", ts: 2000 },
        ],
      })
      .mockResolvedValueOnce({ device: { deviceId: "device-2" } });

    await runDevicesApprove([]);

    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: "device.pair.list" }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "device.pair.approve",
        params: { requestId: "req-2" },
      }),
    );
  });

  it("uses latest pending request when --latest is passed", async () => {
    callGateway
      .mockResolvedValueOnce({
        pending: [
          { requestId: "req-2", ts: 2000 },
          { requestId: "req-3", ts: 3000 },
        ],
      })
      .mockResolvedValueOnce({ device: { deviceId: "device-3" } });

    await runDevicesApprove(["req-old", "--latest"]);

    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "device.pair.approve",
        params: { requestId: "req-3" },
      }),
    );
  });

  it("prints an error and exits when no pending requests are available", async () => {
    callGateway.mockResolvedValueOnce({ pending: [] });

    await runDevicesApprove([]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.list" }),
    );
    expect(runtime.error).toHaveBeenCalledWith("No pending device pairing requests to approve");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "device.pair.approve" }),
    );
  });
});

describe("devices cli remove", () => {
  afterEach(() => {
    callGateway.mockReset();
    withProgress.mockClear();
    runtime.log.mockReset();
    runtime.error.mockReset();
    runtime.exit.mockReset();
  });

  it("removes a paired device by id", async () => {
    callGateway.mockResolvedValueOnce({ deviceId: "device-1" });

    await runDevicesCommand(["remove", "device-1"]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "device.pair.remove",
        params: { deviceId: "device-1" },
      }),
    );
  });
});

describe("devices cli clear", () => {
  afterEach(() => {
    callGateway.mockReset();
    withProgress.mockClear();
    runtime.log.mockReset();
    runtime.error.mockReset();
    runtime.exit.mockReset();
  });

  it("requires --yes before clearing", async () => {
    await runDevicesCommand(["clear"]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("Refusing to clear pairing table without --yes");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("clears paired devices and optionally pending requests", async () => {
    callGateway
      .mockResolvedValueOnce({
        paired: [{ deviceId: "device-1" }, { deviceId: "device-2" }],
        pending: [{ requestId: "req-1" }],
      })
      .mockResolvedValueOnce({ deviceId: "device-1" })
      .mockResolvedValueOnce({ deviceId: "device-2" })
      .mockResolvedValueOnce({ requestId: "req-1", deviceId: "device-1" });

    await runDevicesCommand(["clear", "--yes", "--pending"]);

    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: "device.pair.list" }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: "device.pair.remove", params: { deviceId: "device-1" } }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ method: "device.pair.remove", params: { deviceId: "device-2" } }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ method: "device.pair.reject", params: { requestId: "req-1" } }),
    );
  });
});
