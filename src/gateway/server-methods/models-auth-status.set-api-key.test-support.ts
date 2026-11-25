import { expect, it, vi, type Mock } from "vitest";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions } from "./types.js";

type RespondOptions = GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> };

/** `models.authSetApiKey` cases share the auth-status suite's mocked owners. */
export function registerModelAuthSetApiKeyTests({
  mocks,
  createOptions,
  setApiKeyHandler,
}: {
  mocks: {
    getRuntimeConfig: Mock;
    listAgentIds: Mock;
    saveModelProviderApiKey: Mock;
    refreshActiveProviderAuthRuntimeSnapshot: Mock;
  };
  createOptions: (params?: Record<string, unknown>) => RespondOptions;
  setApiKeyHandler: GatewayRequestHandler;
}) {
  const firstRespondCall = (opts: RespondOptions) => opts.respond.mock.calls[0];
  const expectSuccess = (opts: RespondOptions, payload: unknown) =>
    expect(firstRespondCall(opts)).toEqual([true, payload, undefined]);

  it("models.authSetApiKey reports both application and refresh warnings after saving", async () => {
    const config = { agents: { entries: { main: {}, writer: {} } } };
    const warning = "Provider settings were saved but not applied.";
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.listAgentIds.mockReturnValue(["main", "writer"]);
    mocks.saveModelProviderApiKey.mockResolvedValueOnce({
      profileId: "openrouter:manual",
      warning,
    });
    mocks.refreshActiveProviderAuthRuntimeSnapshot.mockRejectedValueOnce(
      new Error("refresh failed"),
    );
    const opts = createOptions({ provider: "OpenRouter", apiKey: "test-key", agentId: "Writer" });
    await setApiKeyHandler(opts);
    expect(mocks.saveModelProviderApiKey).toHaveBeenCalledWith({
      config,
      provider: "openrouter",
      apiKey: "test-key",
      agentId: "writer",
      agentDir: "/tmp/agent-writer",
      assertCurrent: expect.any(Function),
    });
    expectSuccess(opts, {
      provider: "openrouter",
      profileId: "openrouter:manual",
      warning: expect.any(String),
    });
    expect(firstRespondCall(opts)?.[1]?.warning).toContain(warning);
    expect(firstRespondCall(opts)?.[1]?.warning).toContain("openclaw gateway restart");
  });

  it("models.authSetApiKey finishes an admitted save after the requester loses authority", async () => {
    mocks.getRuntimeConfig.mockReturnValue({ agents: { entries: { main: {} } } });
    mocks.listAgentIds.mockReturnValue(["main"]);
    let authorized = true;
    mocks.saveModelProviderApiKey.mockImplementationOnce(async ({ assertCurrent }) => {
      assertCurrent();
      // Authority is checked once at admission; revocation applies to the next request.
      authorized = false;
      assertCurrent();
      return { profileId: "sample:manual" };
    });
    const opts = Object.assign(createOptions({ provider: "sample", apiKey: "test-key" }), {
      hasCurrentClientAuthority: () => authorized,
    });
    await setApiKeyHandler(opts);
    expect(authorized).toBe(false);
    expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).toHaveBeenCalledOnce();
    expect(mocks.saveModelProviderApiKey.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.refreshActiveProviderAuthRuntimeSnapshot.mock.invocationCallOrder[0] ?? 0,
    );
    expectSuccess(opts, { provider: "sample", profileId: "sample:manual" });
  });
}
