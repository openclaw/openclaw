import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runAuthorizationPolicies } from "./authorization-policy.js";
import type { AuthorizationPolicyRegistration } from "./authorization-policy.types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { setActivePluginRegistry } from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";

function diagnostics(registry: ReturnType<typeof createPluginRegistryFixture>["registry"]) {
  return registry.registry.diagnostics.map((entry) => ({
    pluginId: entry.pluginId,
    message: entry.message,
  }));
}

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("authorization policy registration", () => {
  it("registers an empty-handler deny policy as a catch-all", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "sender-access",
        name: "Sender Access",
        origin: "workspace",
        contracts: { authorizationPolicies: ["deny-unhandled"] },
      }),
      register(api) {
        api.authorization.registerPolicy({
          id: "deny-unhandled",
          description: "Deny every unhandled operation",
          unhandled: "deny",
          handlers: {},
        });
      },
    });

    expect(registry.registry.authorizationPolicies).toHaveLength(1);
    expect(diagnostics(registry)).toEqual([]);

    const denial = await runAuthorizationPolicies({
      request: {
        operation: "command.invoke",
        phase: "final",
        commandName: "fix",
        owner: { kind: "core" },
        source: "native",
      },
      context: { principal: { kind: "sender", senderId: "maintainer-1" } },
      config: {},
      registry: registry.registry,
    });
    expect(denial).toMatchObject({
      pluginId: "sender-access",
      policyId: "deny-unhandled",
      code: "policy-unhandled-operation",
    });
  });

  it("rejects malformed handler maps", () => {
    const malformedPolicies = [
      { id: "missing", description: "Missing handlers" },
      { id: "null", description: "Null handlers", handlers: null },
      { id: "array", description: "Array handlers", handlers: [] },
      { id: "empty-pass", description: "Empty pass-through handlers", handlers: {} },
      {
        id: "unknown-key",
        description: "Unknown handler key",
        handlers: { "unknown.operation": () => ({ effect: "pass" }) },
      },
      {
        id: "non-function",
        description: "Non-function handler",
        handlers: { "tool.call": "pass" },
      },
    ] as unknown as AuthorizationPolicyRegistration[];
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "sender-access",
        name: "Sender Access",
        origin: "workspace",
        contracts: { authorizationPolicies: malformedPolicies.map((policy) => policy.id) },
      }),
      register(api) {
        for (const policy of malformedPolicies) {
          api.authorization.registerPolicy(policy);
        }
      },
    });

    expect(registry.registry.authorizationPolicies).toHaveLength(0);
    expect(diagnostics(registry)).toEqual(
      malformedPolicies.map(() => ({
        pluginId: "sender-access",
        message: "authorization policy registration requires valid id, description, and handlers",
      })),
    );
  });

  it("registers an explicitly enabled installed policy through the nested API", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "sender-access",
        name: "Sender Access",
        origin: "workspace",
        contracts: { authorizationPolicies: ["maintainer-actions"] },
      }),
      register(api) {
        api.authorization.registerPolicy({
          id: "maintainer-actions",
          description: "Limit maintainer actions",
          handlers: {
            "command.invoke": (request) =>
              request.commandName === "restart"
                ? { effect: "deny", code: "destructive-command" }
                : { effect: "pass" },
          },
        });
      },
    });

    expect(
      registry.registry.authorizationPolicies.map((entry) => [entry.pluginId, entry.policy.id]),
    ).toEqual([["sender-access", "maintainer-actions"]]);
    expect(diagnostics(registry)).toEqual([]);

    const denial = await runAuthorizationPolicies({
      request: {
        operation: "command.invoke",
        phase: "final",
        commandName: "restart",
        owner: { kind: "core" },
        source: "native",
      },
      context: { principal: { kind: "sender", senderId: "maintainer-1" } },
      config: {},
      registry: registry.registry,
    });
    expect(denial).toMatchObject({
      pluginId: "sender-access",
      policyId: "maintainer-actions",
      code: "destructive-command",
    });
  });

  it("preserves non-enumerable handler functions in the validated snapshot", async () => {
    const handlers: AuthorizationPolicyRegistration["handlers"] = {};
    Object.defineProperty(handlers, "tool.call", {
      value: () => ({ effect: "deny", code: "non-enumerable-deny" }),
    });
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "sender-access",
        name: "Sender Access",
        origin: "workspace",
        contracts: { authorizationPolicies: ["non-enumerable"] },
      }),
      register(api) {
        api.authorization.registerPolicy({
          id: "non-enumerable",
          description: "Preserve validated handler descriptors",
          handlers,
        });
      },
    });

    expect(diagnostics(registry)).toEqual([]);
    await expect(
      runAuthorizationPolicies({
        request: {
          operation: "tool.call",
          phase: "final",
          toolName: "exec",
          input: {},
        },
        context: { principal: { kind: "sender", senderId: "maintainer-1" } },
        config: {},
        registry: registry.registry,
      }),
    ).resolves.toMatchObject({ code: "non-enumerable-deny" });
  });

  it("rejects installed policies without declaration or explicit enablement", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "undeclared",
        name: "Undeclared",
        origin: "workspace",
      }),
      register(api) {
        api.authorization.registerPolicy({
          id: "sender-access",
          description: "Undeclared policy",
          handlers: { "tool.call": () => ({ effect: "pass" }) },
        });
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "implicit",
        name: "Implicit",
        origin: "workspace",
        contracts: { authorizationPolicies: ["sender-access"] },
        explicitlyEnabled: false,
        activationSource: "default",
      }),
      register(api) {
        api.authorization.registerPolicy({
          id: "sender-access",
          description: "Implicit policy",
          handlers: { "tool.call": () => ({ effect: "pass" }) },
        });
      },
    });

    expect(registry.registry.authorizationPolicies).toHaveLength(0);
    expect(diagnostics(registry)).toEqual([
      {
        pluginId: "undeclared",
        message: "plugin must declare contracts.authorizationPolicies for: sender-access",
      },
      {
        pluginId: "implicit",
        message:
          "plugin must be explicitly enabled to register authorization policy: sender-access",
      },
    ]);
  });

  it("keeps legacy trusted policy ids separate from final authorization policy ids", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "duplicate",
        name: "Duplicate",
        origin: "workspace",
        contracts: {
          trustedToolPolicies: ["shared-policy"],
          authorizationPolicies: ["shared-policy"],
        },
      }),
      register(api) {
        api.registerTrustedToolPolicy({
          id: "shared-policy",
          description: "Legacy policy",
          evaluate: () => undefined,
        });
        api.authorization.registerPolicy({
          id: "shared-policy",
          description: "Final policy",
          handlers: { "tool.call": () => ({ effect: "pass" }) },
        });
      },
    });

    expect(registry.registry.trustedToolPolicies).toHaveLength(1);
    expect(registry.registry.authorizationPolicies).toHaveLength(1);
    expect(diagnostics(registry)).toEqual([]);
  });

  it("allows distinct plugins to register the same local policy id", () => {
    const { config, registry } = createPluginRegistryFixture();
    for (const pluginId of ["sender-access-a", "sender-access-b"]) {
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({
          id: pluginId,
          name: pluginId,
          origin: "workspace",
          contracts: { authorizationPolicies: ["maintainer-actions"] },
        }),
        register(api) {
          api.authorization.registerPolicy({
            id: "maintainer-actions",
            description: `Maintainer actions from ${pluginId}`,
            handlers: { "tool.call": () => ({ effect: "pass" }) },
          });
        },
      });
    }

    expect(
      registry.registry.authorizationPolicies.map((entry) => [entry.pluginId, entry.policy.id]),
    ).toEqual([
      ["sender-access-a", "maintainer-actions"],
      ["sender-access-b", "maintainer-actions"],
    ]);
    expect(diagnostics(registry)).toEqual([]);
  });

  it("rejects a duplicate local policy id from the same plugin", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "sender-access",
        name: "Sender Access",
        origin: "workspace",
        contracts: { authorizationPolicies: ["maintainer-actions"] },
      }),
      register(api) {
        api.authorization.registerPolicy({
          id: "maintainer-actions",
          description: "First registration",
          handlers: { "tool.call": () => ({ effect: "pass" }) },
        });
        api.authorization.registerPolicy({
          id: "maintainer-actions",
          description: "Duplicate registration",
          handlers: { "tool.call": () => ({ effect: "deny", code: "duplicate" }) },
        });
      },
    });

    expect(registry.registry.authorizationPolicies).toHaveLength(1);
    expect(registry.registry.authorizationPolicies[0]?.policy.description).toBe(
      "First registration",
    );
    expect(diagnostics(registry)).toEqual([
      {
        pluginId: "sender-access",
        message: "authorization policy id already registered: maintainer-actions",
      },
    ]);
  });

  it("runs bundled authorization policies before installed policies", async () => {
    const calls: string[] = [];
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "installed",
        name: "Installed",
        origin: "workspace",
        contracts: { authorizationPolicies: ["installed-policy"] },
      }),
      register(api) {
        api.authorization.registerPolicy({
          id: "installed-policy",
          description: "Installed policy",
          handlers: {
            "command.invoke": () => {
              calls.push("installed");
              return { effect: "pass" };
            },
          },
        });
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "bundled", name: "Bundled", origin: "bundled" }),
      register(api) {
        api.authorization.registerPolicy({
          id: "bundled-policy",
          description: "Bundled policy",
          handlers: {
            "command.invoke": () => {
              calls.push("bundled");
              return { effect: "pass" };
            },
          },
        });
      },
    });

    await runAuthorizationPolicies({
      request: {
        operation: "command.invoke",
        phase: "final",
        commandName: "fix",
        owner: { kind: "core" },
        source: "text",
      },
      context: { principal: { kind: "sender", senderId: "maintainer-1" } },
      config: {},
      registry: registry.registry,
    });

    expect(calls).toEqual(["bundled", "installed"]);
  });
});
