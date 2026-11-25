import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { createGatewayTool } from "./gateway-tool.js";

const { callGateway, handleGatewayRequest } = vi.hoisted(() => ({
  callGateway: vi.fn<(options: CallGatewayOptions) => Promise<unknown>>(),
  handleGatewayRequest: vi.fn<(options: GatewayRequestOptions) => Promise<void>>(),
}));

vi.mock("../../gateway/call.js", () => ({ callGateway }));
vi.mock("../../gateway/server-methods.js", () => ({ handleGatewayRequest }));

const snapshot = { hash: "revision", config: { gateway: { mode: "local" } } };
const configReads = ["config.get", "config.schema.lookup"] as const;

describe("gateway config tool routing", () => {
  let context: GatewayRequestContext;

  const runAsCaller = <T>(run: () => Promise<T>) =>
    withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:test",
        operationalRunInstance: { instanceId: "instance", runId: "run" },
        receiptAuthority: () => true,
        gatewayContextResolver: () => context,
      },
      run,
    );

  const read = (
    action: (typeof configReads)[number],
    extra: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) => createGatewayTool().execute("config-read", { action, path: "gateway", ...extra }, signal);

  beforeEach(() => {
    setRuntimeConfigSnapshot({ gateway: { mode: "local", port: 18789 } });
    context = {
      trackExecution: (run) => run(),
      getRuntimeConfig: () => ({ gateway: { mode: "local" } }),
    } as GatewayRequestContext;
    callGateway.mockReset().mockResolvedValue(snapshot);
    handleGatewayRequest.mockReset().mockImplementation(async ({ respond }) => {
      respond(true, snapshot);
    });
  });

  afterEach(() => clearRuntimeConfigSnapshot());

  it.each(["config.schema.lookup"] as const)(
    "dispatches admitted %s reads locally with least privilege",
    async (action) => {
      const result = await runAsCaller(() => read(action));

      expect(result.details).toMatchObject({ ok: true });
      expect(handleGatewayRequest).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          req: expect.objectContaining({ method: action }),
          context,
          client: expect.objectContaining({
            connect: expect.objectContaining({ scopes: ["operator.read"] }),
          }),
        }),
      );
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it.each([{ gatewayUrl: "ws://127.0.0.1:18789" }])(
    "preserves explicit transport options %j",
    async (overrides) => {
      await runAsCaller(() => read("config.get", { ...overrides, timeoutMs: 2345 }));

      expect(callGateway).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          url: overrides.gatewayUrl,
          token: undefined,
          timeoutMs: 2345,
          scopes: ["operator.read"],
        }),
      );
      expect(handleGatewayRequest).not.toHaveBeenCalled();
    },
  );

  it("preserves schema misses from the in-process router", async () => {
    handleGatewayRequest.mockImplementationOnce(async ({ respond }) => {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "config schema path not found",
      });
    });
    const result = await runAsCaller(() => read("config.schema.lookup"));
    expect(result.details).toEqual({
      ok: false,
      code: "schema_path_not_found",
      path: "gateway",
      message: "config schema path not found",
    });
  });

  it("does not dispatch a cancelled config read", async () => {
    const controller = new AbortController();
    controller.abort(new Error("config read cancelled"));
    await expect(runAsCaller(() => read("config.get", {}, controller.signal))).rejects.toThrow(
      "config read cancelled",
    );
    expect(handleGatewayRequest).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });
});
