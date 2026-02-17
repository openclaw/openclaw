import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("./progress.js", () => ({
  withProgress: (_opts: unknown, fn: () => Promise<unknown>) => fn(),
}));

const { callGatewayFromCli } = await import("./gateway-rpc.js");

describe("callGatewayFromCli retry", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("retries once on timeout for read-only cron methods", async () => {
    callGatewayMock
      .mockRejectedValueOnce(new Error("gateway timeout after 90000ms\nGateway target: ..."))
      .mockResolvedValueOnce({ ok: true });

    const result = await callGatewayFromCli("cron.status", { timeout: "90000", json: true });
    expect(result).toEqual({ ok: true });
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("retries for cron.list on timeout", async () => {
    callGatewayMock
      .mockRejectedValueOnce(new Error("gateway timeout after 30000ms\n..."))
      .mockResolvedValueOnce({ jobs: [] });

    const result = await callGatewayFromCli("cron.list", { timeout: "30000", json: true });
    expect(result).toEqual({ jobs: [] });
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("retries for cron.runs on timeout", async () => {
    callGatewayMock
      .mockRejectedValueOnce(new Error("gateway timeout after 90000ms\n..."))
      .mockResolvedValueOnce({ runs: [] });

    const result = await callGatewayFromCli("cron.runs", { timeout: "90000", json: true });
    expect(result).toEqual({ runs: [] });
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry for non-cron methods on timeout", async () => {
    callGatewayMock.mockRejectedValueOnce(
      new Error("gateway timeout after 30000ms\nGateway target: ..."),
    );

    await expect(
      callGatewayFromCli("agent.status", { timeout: "30000", json: true }),
    ).rejects.toThrow("gateway timeout");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry for mutating cron methods", async () => {
    callGatewayMock.mockRejectedValueOnce(
      new Error("gateway timeout after 90000ms\nGateway target: ..."),
    );

    await expect(callGatewayFromCli("cron.add", { timeout: "90000", json: true })).rejects.toThrow(
      "gateway timeout",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry for non-timeout errors on cron methods", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("connection refused"));

    await expect(
      callGatewayFromCli("cron.status", { timeout: "90000", json: true }),
    ).rejects.toThrow("connection refused");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });
});
