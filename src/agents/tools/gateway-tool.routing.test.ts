import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
  let currentContext: GatewayRequestContext | undefined;
  let callerActive: boolean;

  const runAsCaller = <T>(run: () => Promise<T>) =>
    withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:test",
        operationalRunInstance: { instanceId: "instance", runId: "run" },
        receiptAuthority: () => callerActive,
        gatewayContextResolver: () => currentContext,
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
    currentContext = context;
    callerActive = true;
    callGateway.mockReset().mockResolvedValue(snapshot);
    handleGatewayRequest.mockReset().mockImplementation(async ({ respond }) => {
      respond(true, snapshot);
    });
  });

  afterEach(() => clearRuntimeConfigSnapshot());

  it.each(configReads)(
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

  it.each([{ gatewayUrl: "ws://127.0.0.1:18789" }, { gatewayToken: "explicit-test-token" }])(
    "preserves explicit transport options %j",
    async (overrides) => {
      await runAsCaller(() => read("config.get", { ...overrides, timeoutMs: 2345 }));

      expect(callGateway).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          url: overrides.gatewayUrl,
          token: overrides.gatewayToken,
          timeoutMs: 2345,
          scopes: ["operator.read"],
        }),
      );
      expect(handleGatewayRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["standalone", "localEmbedded"])("retains %s transport routing", async (kind) => {
    if (kind === "localEmbedded") {
      context.localEmbedded = true;
      await runAsCaller(() => read("config.get"));
    } else {
      await read("config.get");
    }
    expect(callGateway).toHaveBeenCalledOnce();
    expect(handleGatewayRequest).not.toHaveBeenCalled();
  });

  it.each(["caller", "gateway"])("rejects retired %s before dispatch", async (owner) => {
    await expect(
      runAsCaller(async () => {
        if (owner === "caller") {
          callerActive = false;
        } else {
          currentContext = undefined;
        }
        return await read("config.get");
      }),
    ).rejects.toThrow(/authority.*no longer active|Gateway instance unavailable/);
    expect(callGateway).not.toHaveBeenCalled();
    expect(handleGatewayRequest).not.toHaveBeenCalled();
  });

  it("rejects a result after the admitting Gateway is replaced", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    handleGatewayRequest.mockImplementationOnce(async ({ respond }) => {
      entered.resolve();
      await release.promise;
      respond(true, snapshot);
    });
    const pending = runAsCaller(() => read("config.get"));
    const rejected = expect(pending).rejects.toThrow("Gateway instance unavailable");
    await entered.promise;
    currentContext = { ...context };
    release.resolve();
    await rejected;
    expect(callGateway).not.toHaveBeenCalled();
  });

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

  it("honors the caller's deadline while a local handler is pending", async () => {
    const release = createDeferred();
    handleGatewayRequest.mockImplementationOnce(async ({ respond }) => {
      await release.promise;
      respond(true, snapshot);
    });
    try {
      await expect(runAsCaller(() => read("config.get", { timeoutMs: 10 }))).rejects.toThrow(
        "gateway request timeout for config.get",
      );
    } finally {
      release.resolve();
    }
    expect(callGateway).not.toHaveBeenCalled();
  });
});
