import { beforeEach, describe, expect, it, vi } from "vitest";

const callGateway = vi.fn();
const withProgress = vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => await fn());

vi.mock("../gateway/call.js", () => ({
  callGateway,
}));

vi.mock("./progress.js", () => ({
  withProgress,
}));

const { callGatewayFromCli } = await import("./gateway-rpc.js");

describe("callGatewayFromCli", () => {
  beforeEach(() => {
    callGateway.mockReset();
    withProgress.mockClear();
  });

  it("uses probe mode for quiet calls", async () => {
    callGateway.mockResolvedValueOnce({ ok: true });

    await callGatewayFromCli("cron.status", { timeout: "30000" }, {}, { quiet: true });

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.status",
        mode: "probe",
        clientName: "cli",
      }),
    );
  });

  it("retries transient transport errors with probe mode after the first CLI attempt", async () => {
    callGateway
      .mockRejectedValueOnce(new Error("gateway closed (1000 normal closure): no close reason"))
      .mockResolvedValueOnce({ ok: true });

    await callGatewayFromCli("cron.add", { timeout: "30000" }, { name: "job" });

    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(callGateway.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ method: "cron.add", mode: "cli" }),
    );
    expect(callGateway.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ method: "cron.add", mode: "probe" }),
    );
  });

  it("does not retry non-transport errors", async () => {
    callGateway.mockRejectedValueOnce(new Error("active gateway does not support required method"));

    await expect(
      callGatewayFromCli("cron.add", { timeout: "30000" }, { name: "job" }),
    ).rejects.toThrow("active gateway does not support required method");

    expect(callGateway).toHaveBeenCalledTimes(1);
  });

  it("stops after three transient failures", async () => {
    callGateway.mockRejectedValue(
      new Error("gateway closed (1006 abnormal closure (no close frame)): no close reason"),
    );

    await expect(
      callGatewayFromCli("cron.add", { timeout: "30000" }, { name: "job" }),
    ).rejects.toThrow("gateway closed (1006 abnormal closure (no close frame)): no close reason");

    expect(callGateway).toHaveBeenCalledTimes(3);
    expect(callGateway.mock.calls.map((call) => call[0]?.mode)).toEqual(["cli", "probe", "probe"]);
  });
});
