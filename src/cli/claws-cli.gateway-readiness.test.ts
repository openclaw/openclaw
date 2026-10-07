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
    mocks.callGatewayFromCli.mockResolvedValue({
      config: { agents: { entries: { worker: {} } } },
      configRevisionHash: "revision-new",
      appliedConfigHash: "revision-new",
      reloadSettled: true,
    });

    await expect(waitUntilGatewayAgentAvailable("worker")).resolves.toBeUndefined();

    expect(mocks.callGatewayFromCli).toHaveBeenCalledOnce();
    expect(mocks.callGatewayFromCli).toHaveBeenCalledWith("config.get", { timeout: "5000" }, {});
    expect(mocks.sleep).not.toHaveBeenCalled();
  });

  it("waits for the requested agent and settled revision after a cached response", async () => {
    mocks.callGatewayFromCli
      .mockResolvedValueOnce({
        config: { agents: { entries: { other: {} } } },
        configRevisionHash: "revision-old",
        appliedConfigHash: "revision-old",
        reloadSettled: true,
      })
      .mockResolvedValueOnce({
        config: { agents: { entries: { worker: {} } } },
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-old",
        reloadSettled: true,
      })
      .mockResolvedValueOnce({
        config: { agents: { entries: { worker: {} } } },
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-new",
      })
      .mockResolvedValueOnce({
        config: { agents: { entries: { worker: {} } } },
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-new",
        reloadSettled: false,
      })
      .mockResolvedValueOnce({
        config: { agents: { entries: { worker: {} } } },
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-new",
        reloadSettled: true,
      });

    await expect(waitUntilGatewayAgentAvailable("worker")).resolves.toBeUndefined();

    expect(mocks.callGatewayFromCli).toHaveBeenCalledTimes(5);
    expect(mocks.sleep).toHaveBeenCalledTimes(4);
    expect(mocks.sleep).toHaveBeenCalledWith(100);
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
