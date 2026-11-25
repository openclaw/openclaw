import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import { oauthCredential } from "./models-auth-status.health.test-support.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions } from "./types.js";

type RespondOptions = GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> };

/** Order mutations share the status suite's prepared auth owner and lifecycle. */
export function registerModelAuthOrderTests({
  mocks,
  setPreparedProfiles,
  createOrderOptions,
  orderHandler,
  expectSuccess,
}: {
  mocks: {
    getRuntimeConfig: Mock;
    prepareModelRuntimeSnapshot: Mock;
    setAuthProfileOrder: Mock;
  };
  setPreparedProfiles: (profiles: AuthProfileStore["profiles"]) => void;
  createOrderOptions: (params: Record<string, unknown>) => RespondOptions;
  orderHandler: GatewayRequestHandler;
  expectSuccess: (opts: RespondOptions, payload: unknown) => void;
}) {
  const firstRespondCall = (opts: RespondOptions) => opts.respond.mock.calls[0];

  describe("models.authOrderSet", () => {
    beforeEach(() => {
      setPreparedProfiles({
        "openai:one": oauthCredential("openai", { access: "one", refresh: "one-refresh" }),
        "openai:two": oauthCredential("openai", { access: "two", refresh: "two-refresh" }),
      });
    });

    it("publishes the durable order before acknowledging it", async () => {
      const publication = createDeferred();
      const started = createDeferred();
      mocks.prepareModelRuntimeSnapshot.mockImplementationOnce(() => {
        started.resolve();
        return publication.promise;
      });
      const opts = createOrderOptions({
        provider: "openai",
        profileIds: ["openai:two", "openai:one"],
      });

      const pending = orderHandler(opts);
      await started.promise;

      expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
        agentDir: "/tmp/agent",
        provider: "openai",
        order: ["openai:two", "openai:one"],
      });
      expect(opts.respond).not.toHaveBeenCalled();

      publication.resolve();
      await pending;
      expect(firstRespondCall(opts)?.slice(0, 2)).toEqual([
        true,
        { provider: "openai", profileIds: ["openai:two", "openai:one"] },
      ]);
    });

    it("preserves the committed reset when runtime publication fails", async () => {
      mocks.prepareModelRuntimeSnapshot.mockRejectedValueOnce(new Error("publication failed"));
      const opts = createOrderOptions({ provider: "openai" });
      await orderHandler(opts);
      expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
        agentDir: "/tmp/agent",
        provider: "openai",
        order: null,
      });
      expectSuccess(opts, {
        provider: "openai",
        profileIds: null,
        warning: expect.stringContaining("Profile priority saved"),
      });
    });

    it.each([
      {
        params: { provider: "openai", profileIds: ["openai:two", "openai:one"] },
        config: { auth: { order: { openai: ["openai:one", "openai:two"] } } },
        message: "auth configuration",
      },
      {
        params: { provider: "openai", profileIds: ["openai:one"] },
        message: "every available profile",
      },
      {
        params: { provider: "anthropic", profileIds: ["openai:one"] },
        message: "unavailable for provider anthropic",
      },
      {
        params: { provider: "openai", unexpected: true },
        message: "invalid models.authOrderSet params",
      },
    ])("rejects invalid profile priority without writing: $message", async (scenario) => {
      if (scenario.config) {
        mocks.getRuntimeConfig.mockReturnValue(scenario.config);
      }
      const opts = createOrderOptions(scenario.params);
      await orderHandler(opts);
      expect(mocks.setAuthProfileOrder).not.toHaveBeenCalled();
      expect(firstRespondCall(opts)?.[0]).toBe(false);
      expect(firstRespondCall(opts)?.[2]?.message).toContain(scenario.message);
    });
  });
}
