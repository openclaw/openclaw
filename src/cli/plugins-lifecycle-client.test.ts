import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCapabilityConsentErrorDetails } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";

const mocks = vi.hoisted(() => ({ lock: vi.fn(), call: vi.fn(), config: vi.fn() }));
vi.mock("../infra/gateway-lock.js", () => ({ readActiveGatewayLockIdentity: mocks.lock }));
vi.mock("../gateway/call.js", () => ({ callGateway: mocks.call }));
vi.mock("../config/config.js", () => ({ getRuntimeConfig: mocks.config }));
const { resolvePluginLifecycleGateway } = await import("./plugins-lifecycle-client.js");

describe("plugin lifecycle CLI transport", () => {
  beforeEach(() => {
    mocks.lock.mockReset().mockResolvedValue({ port: 19001 });
    mocks.config.mockReset().mockReturnValue({ gateway: { port: 18789 } });
    mocks.call.mockReset().mockResolvedValue({ runtime: { generation: 2 } });
  });

  it("uses the active local owner's port and requires hot lifecycle support", async () => {
    const gateway = await resolvePluginLifecycleGateway();
    await gateway?.("plugins.refresh", {});
    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({
        localPortOverride: 19001,
        ignoreEnvUrlOverride: true,
        requiredMethods: ["plugins.refresh", "plugins.reload"],
        scopes: ["operator.admin"],
      }),
    );
  });

  it("leaves plugin config validation to the install owner when dispatching recovery", async () => {
    mocks.config.mockImplementation(() => {
      throw Object.assign(new Error("owned plugin path is missing"), { code: "INVALID_CONFIG" });
    });
    const gateway = await resolvePluginLifecycleGateway();
    expect(gateway).not.toBeNull();
    await expect(
      gateway!("plugins.install", { source: "local", path: "/replacement" }),
    ).resolves.toEqual({ runtime: { generation: 2 } });
    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "plugins.install",
        localPortOverride: 19001,
        ignoreEnvUrlOverride: true,
      }),
    );
  });

  it("selects offline execution only when no local owner exists", async () => {
    mocks.lock.mockResolvedValue(null);
    expect(await resolvePluginLifecycleGateway()).toBeNull();
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("propagates a lost reply without retrying a possibly committed mutation", async () => {
    const failure = new Error("connection lost");
    mocks.call.mockRejectedValue(failure);
    const gateway = await resolvePluginLifecycleGateway();
    await expect(gateway?.("plugins.uninstall", { pluginId: "demo" })).rejects.toBe(failure);
    expect(mocks.call).toHaveBeenCalledOnce();
  });

  it.each([
    { method: "plugins.setEnabled", params: { pluginId: "demo", enabled: true } },
    { method: "plugins.reload", params: { plugins: [{ pluginId: "demo" }] } },
  ])(
    "retries $method consent using the inspected artifact's exact token",
    async ({ method, params }) => {
      const oldToken = "a".repeat(64);
      const currentToken = "b".repeat(64);
      mocks.call
        .mockRejectedValueOnce(
          Object.assign(new Error("consent required"), {
            details: buildCapabilityConsentErrorDetails({
              pluginId: "demo",
              reviewToken: oldToken,
            }),
          }),
        )
        .mockResolvedValueOnce({
          plugin: { id: "demo", name: "Demo" },
          reviewToken: currentToken,
          declared: {},
          grants: {},
        })
        .mockResolvedValueOnce({ runtime: { generation: 3 } });
      const consent = vi.fn(async (review: { reviewToken: string }) => ({
        reviewToken: review.reviewToken,
      }));
      const gateway = await resolvePluginLifecycleGateway();
      await gateway?.(method, params, consent);
      expect(consent).toHaveBeenCalledWith(expect.objectContaining({ reviewToken: currentToken }));
      expect(mocks.call).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          method,
          params: {
            ...params,
            acknowledgeCapabilities: { reviewToken: currentToken },
          },
        }),
      );
    },
  );
});
