import { beforeEach, describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callInProcessGatewayToolWithCreation } from "./in-process-gateway.js";

const { callGateway } = vi.hoisted(() => ({ callGateway: vi.fn() }));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  resolveGatewayPort: () => 18789,
}));
vi.mock("../../gateway/call.js", () => ({ callGateway }));
vi.mock("../../gateway/server-plugin-in-process-dispatch.js", () => ({
  getInProcessGatewayRequestContext: () => undefined,
}));

describe("session creation transport deadline", () => {
  beforeEach(() => {
    callGateway.mockReset().mockResolvedValue({ key: "agent:main:dashboard:child" });
  });

  it.each([false, true])(
    "preserves the requested timeout through transport with inherited policy=%s",
    async (inheritPolicy) => {
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          signedAgentRuntimeIdentityToken: "synthetic-runtime-identity",
        },
        () =>
          callInProcessGatewayToolWithCreation(
            "sessions.create",
            { agentId: "main" },
            {
              via: "spawn",
              actor: { type: "agent", id: "main" },
              requesterSessionKey: "agent:main:main",
              ...(inheritPolicy
                ? { inheritedToolPolicy: { version: 1 as const, allow: ["read"], deny: [] } }
                : {}),
            },
            { timeoutMs: 120_000 },
          ),
      );

      expect(callGateway).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          method: "sessions.create",
          params: { agentId: "main" },
          timeoutMs: 120_000,
        }),
      );
    },
  );
});
