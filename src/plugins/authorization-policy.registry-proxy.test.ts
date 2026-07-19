import { describe, expect, it, vi } from "vitest";
import {
  hasAuthorizationPoliciesForOperation,
  runAuthorizationPolicies,
} from "./authorization-policy.js";
import type {
  AuthorizationInvocationContext,
  AuthorizationPolicyRegistration,
} from "./authorization-policy.types.js";
import type { PluginAuthorizationPolicyRegistryRegistration } from "./registry-types.js";

const context: AuthorizationInvocationContext = {
  principal: { kind: "sender", provider: "discord", senderId: "maintainer-1" },
};

const request = {
  operation: "tool.call" as const,
  toolName: "message",
  phase: "final" as const,
  input: { action: "reply" },
};

function registration(
  pluginId: string,
  policy: AuthorizationPolicyRegistration,
): PluginAuthorizationPolicyRegistryRegistration {
  return { pluginId, source: `/plugins/${pluginId}/index.ts`, policy };
}

describe("authorization policy registry proxies", () => {
  it("accepts a forwarding proxy around the trusted registry shell", async () => {
    const handler = vi.fn(() => ({ effect: "pass" as const }));
    const target = {
      authorizationPolicies: [
        registration("forwarded", {
          id: "forwarded",
          description: "Forwarded registry",
          handlers: { "tool.call": handler },
        }),
      ],
    };
    const forwarded = new Proxy(target, {
      get: (source, property, receiver) => Reflect.get(source, property, receiver),
    });

    expect(
      hasAuthorizationPoliciesForOperation({
        operation: "tool.call",
        config: {},
        registry: forwarded,
      }),
    ).toBe(true);
    await expect(
      runAuthorizationPolicies({ request, context, config: {}, registry: forwarded }),
    ).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("fails closed when the trusted registry shell throws on policy access", async () => {
    const get = vi.fn(() => {
      throw new Error("registry unavailable");
    });
    const unreadable = new Proxy({ authorizationPolicies: [] }, { get });

    expect(
      hasAuthorizationPoliciesForOperation({
        operation: "tool.call",
        config: {},
        registry: unreadable,
      }),
    ).toBe(true);
    await expect(
      runAuthorizationPolicies({ request, context, config: {}, registry: unreadable }),
    ).resolves.toMatchObject({ code: "policy-unreadable" });
    expect(get).toHaveBeenCalled();
  });
});
