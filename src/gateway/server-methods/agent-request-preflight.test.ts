// Focused guard coverage for prepareAgentRequestPreflight.
// Verifies that disableTools: true is rejected for external callers and
// admitted for plugin-owned subagent runs — mirroring the cwd guard above it.
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal test helpers
// ---------------------------------------------------------------------------

let seq = 0;

/** Minimal agent params — schema requires only message + idempotencyKey. */
function makeParams(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    message: "write a narrative entry",
    idempotencyKey: `guard-test-${++seq}`,
    ...extra,
  };
}

/** Minimal context stub — preflight only needs getRuntimeConfig + dedupe. */
function makeContext(): GatewayRequestContext {
  return {
    getRuntimeConfig: vi.fn().mockReturnValue({}),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

/** External (non-plugin) client: no internal.pluginRuntimeOwnerId. */
function externalClient(): GatewayClient {
  return {
    connect: {
      client: { id: "test-ext", displayName: "External Test" },
      scopes: [],
    },
  } as unknown as GatewayClient;
}

/** Plugin-owned client: mirrors what createSyntheticPluginRuntimeClient injects. */
function pluginClient(pluginId: string): GatewayClient {
  return {
    connect: {
      client: { id: "test-plugin", displayName: "Plugin Test" },
      scopes: [],
    },
    internal: { pluginRuntimeOwnerId: pluginId },
  } as unknown as GatewayClient;
}

// ---------------------------------------------------------------------------
// disableTools guard tests
// ---------------------------------------------------------------------------

describe("prepareAgentRequestPreflight — disableTools guard", () => {
  it("rejects an external request carrying disableTools: true with INVALID_REQUEST", () => {
    const respond = vi.fn();

    const result = prepareAgentRequestPreflight({
      params: makeParams({ disableTools: true }),
      respond,
      context: makeContext(),
      client: externalClient(),
    });

    expect(result, "preflight should return undefined on rejection").toBeUndefined();
    expect(respond, "respond must be called exactly once").toHaveBeenCalledOnce();
    const [ok, , error] = respond.mock.calls[0] as [
      boolean,
      unknown,
      { code: string; message: string },
    ];
    expect(ok).toBe(false);
    expect(error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(error?.message).toContain("disableTools is reserved for plugin-owned subagent runs");
  });

  it("allows a plugin-owned request with disableTools: true through preflight", () => {
    const respond = vi.fn();

    const result = prepareAgentRequestPreflight({
      params: makeParams({ disableTools: true }),
      respond,
      context: makeContext(),
      client: pluginClient("memory-core"),
    });

    // Guard passes: function returns a non-null preflight object; respond is not called.
    expect(result, "plugin-owned request should pass preflight").toBeDefined();
    expect(respond, "respond must not be called when preflight passes").not.toHaveBeenCalled();
  });
});
