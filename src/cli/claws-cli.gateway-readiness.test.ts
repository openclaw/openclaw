import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ callGatewayFromCli: vi.fn(), sleep: vi.fn() }));
vi.mock("./gateway-rpc.js", () => ({ callGatewayFromCli: mocks.callGatewayFromCli }));
vi.mock("../utils/sleep.js", () => ({ sleep: mocks.sleep }));
const { waitUntilGatewayAgentAvailable } = await import("./claws-cli.gateway-readiness.js");

beforeEach(() => {
  mocks.callGatewayFromCli.mockReset();
  mocks.sleep.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("Claw Gateway agent readiness", () => {
  it("accepts an already-applied Gateway config revision", async () => {
    mocks.callGatewayFromCli
      .mockResolvedValueOnce({
        config: { agents: { entries: { worker: {} } } },
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-new",
      })
      .mockResolvedValueOnce({ monitors: [] });

    await expect(waitUntilGatewayAgentAvailable("worker")).resolves.toBeUndefined();

    expect(mocks.callGatewayFromCli).toHaveBeenCalledTimes(2);
    expect(mocks.callGatewayFromCli).toHaveBeenCalledWith("config.get", { timeout: "5000" }, {});
    expect(mocks.callGatewayFromCli).toHaveBeenLastCalledWith(
      "claws.monitors",
      { timeout: "5000" },
      expect.objectContaining({ phase: "inspect", agentId: "worker" }),
    );
    expect(mocks.sleep).not.toHaveBeenCalled();
  });

  it("waits for the requested agent in an applied revision after a cached response", async () => {
    mocks.callGatewayFromCli
      .mockResolvedValueOnce({
        config: { agents: { entries: { other: {} } } },
        configRevisionHash: "revision-old",
        appliedConfigHash: "revision-old",
      })
      .mockResolvedValueOnce({
        config: { agents: { entries: { worker: {} } } },
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-old",
      })
      .mockResolvedValueOnce({
        config: { agents: { entries: { worker: {} } } },
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-new",
      })
      .mockResolvedValueOnce({ monitors: [] });

    await expect(waitUntilGatewayAgentAvailable("worker")).resolves.toBeUndefined();

    expect(mocks.callGatewayFromCli).toHaveBeenCalledTimes(4);
    expect(mocks.sleep).toHaveBeenCalledTimes(2);
    expect(mocks.sleep).toHaveBeenCalledWith(100);
  });

  it("waits for the serving Gateway to settle even when config revisions match", async () => {
    const appliedConfig = {
      config: { agents: { entries: { worker: {} } } },
      configRevisionHash: "revision-new",
      appliedConfigHash: "revision-new",
    };
    mocks.callGatewayFromCli
      .mockResolvedValueOnce(appliedConfig)
      .mockRejectedValueOnce(new Error("Gateway scheduler or configuration is changing"))
      .mockResolvedValueOnce(appliedConfig)
      .mockResolvedValueOnce({ monitors: [] });

    await expect(waitUntilGatewayAgentAvailable("worker")).resolves.toBeUndefined();

    expect(mocks.callGatewayFromCli).toHaveBeenCalledTimes(4);
    expect(mocks.sleep).toHaveBeenCalledOnce();
  });

  it("reports the last Gateway error after the reload deadline", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(15_000);
    mocks.callGatewayFromCli.mockRejectedValue(new Error("gateway unavailable"));

    await expect(waitUntilGatewayAgentAvailable("worker")).rejects.toThrow(
      "Gateway did not apply the Claw agent configuration in time: gateway unavailable",
    );

    expect(mocks.callGatewayFromCli).toHaveBeenCalledOnce();
    expect(mocks.sleep).toHaveBeenCalledOnce();
  });
});
