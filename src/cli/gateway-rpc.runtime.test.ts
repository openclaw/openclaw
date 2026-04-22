import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("./progress.js", () => ({
  withProgress: async (_opts: unknown, run: () => Promise<unknown>) => await run(),
}));

let callGatewayFromCliRuntime: typeof import("./gateway-rpc.runtime.js").callGatewayFromCliRuntime;

describe("callGatewayFromCliRuntime token resolution (#70365)", () => {
  const originalEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  beforeEach(async () => {
    ({ callGatewayFromCliRuntime } = await import("./gateway-rpc.runtime.js"));
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    if (originalEnvToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalEnvToken;
    }
  });

  it("uses OPENCLAW_GATEWAY_TOKEN when --token flag is not passed", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-123";
    await callGatewayFromCliRuntime("status", { json: true });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock.mock.calls[0]?.[0]).toMatchObject({ token: "env-token-123" });
  });

  it("prefers explicit --token flag over OPENCLAW_GATEWAY_TOKEN env var", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    await callGatewayFromCliRuntime("status", { json: true, token: "flag-token" });
    expect(callGatewayMock.mock.calls[0]?.[0]).toMatchObject({ token: "flag-token" });
  });

  it("treats empty-string --token as unset and still falls back to env var", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    await callGatewayFromCliRuntime("status", { json: true, token: "" });
    expect(callGatewayMock.mock.calls[0]?.[0]).toMatchObject({ token: "env-token" });
  });

  it("passes undefined when neither flag nor env is set", async () => {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    await callGatewayFromCliRuntime("status", { json: true });
    expect(callGatewayMock.mock.calls[0]?.[0]).toMatchObject({ token: undefined });
  });
});
