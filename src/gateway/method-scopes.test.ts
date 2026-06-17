/**
 * Gateway method-scope policy tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  authorizeOperatorScopesForMethod,
  isGatewayMethodClassified,
  resolveLeastPrivilegeOperatorScopesForMethod,
  resolveRequiredOperatorScopeForMethod,
} from "./method-scopes.js";
import { createPluginGatewayMethodDescriptor } from "./methods/registry.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const RESERVED_ADMIN_PLUGIN_METHOD = "config.plugin.inspect";
const pluginHandler: GatewayRequestHandler = ({ respond }) => respond(true, {});

function setPluginGatewayMethodScope(
  method: string,
  scope: "operator.read" | "operator.write" | "operator.admin",
) {
  const registry = createEmptyPluginRegistry();
  registry.gatewayHandlers[method] = pluginHandler;
  registry.gatewayMethodDescriptors.push(
    createPluginGatewayMethodDescriptor({
      pluginId: "test",
      name: method,
      handler: pluginHandler,
      scope,
    }),
  );
  setActivePluginRegistry(registry);
}

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("method scope resolution", () => {
  it.each([
    ["sessions.resolve", ["operator.read"]],
    ["tasks.list", ["operator.read"]],
    ["tasks.get", ["operator.read"]],
    ["config.schema.lookup", ["operator.read"]],
    ["sessions.create", ["operator.write"]],
    ["sessions.send", ["operator.write"]],
    ["sessions.abort", ["operator.write"]],
    ["tasks.cancel", ["operator.write"]],
    ["tools.invoke", ["operator.write"]],
    ["sessions.messages.subscribe", ["operator.read"]],
    ["sessions.messages.unsubscribe", ["operator.read"]],
    ["environments.list", ["operator.read"]],
    ["environments.status", ["operator.read"]],
    ["diagnostics.stability", ["operator.read"]],
    ["node.pair.approve", ["operator.pairing"]],
    ["poll", ["operator.write"]],
    ["talk.client.create", ["operator.write"]],
    ["talk.client.toolCall", ["operator.write"]],
    ["talk.client.steer", ["operator.write"]],
    ["talk.session.create", ["operator.write"]],
    ["talk.session.join", ["operator.write"]],
    ["talk.session.appendAudio", ["operator.write"]],
    ["talk.session.startTurn", ["operator.write"]],
    ["talk.session.endTurn", ["operator.write"]],
    ["talk.session.cancelTurn", ["operator.write"]],
    ["talk.session.cancelOutput", ["operator.write"]],
    ["talk.session.submitToolResult", ["operator.write"]],
    ["talk.session.steer", ["operator.write"]],
    ["talk.session.close", ["operator.write"]],
    ["update.status", ["operator.admin"]],
    ["config.schema", ["operator.admin"]],
    ["config.patch", ["operator.admin"]],
    ["nativeHook.invoke", ["operator.admin"]],
    ["wizard.start", ["operator.admin"]],
    ["update.run", ["operator.admin"]],
    ["exec.approvals.get", ["operator.admin"]],
    ["exec.approvals.set", ["operator.admin"]],
    ["exec.approvals.node.get", ["operator.admin"]],
    ["exec.approvals.node.set", ["operator.admin"]],
  ])("resolves least-privilege scopes for %s", (method, expected) => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual(expected);
  });

  it("leaves node-only pending drain outside operator scopes", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("node.pending.drain")).toStrictEqual([]);
  });

  it("classifies plugin session actions with a CLI-safe default operator scope", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("plugins.sessionAction")).toEqual([
      "operator.write",
    ]);
    expect(isGatewayMethodClassified("plugins.sessionAction")).toBe(true);
    expect(authorizeOperatorScopesForMethod("plugins.sessionAction", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.write",
    });
  });

  it("derives least-privilege scopes from registered plugin session action params", () => {
    const registry = createEmptyPluginRegistry();
    registry.sessionActions = [
      {
        pluginId: "scope-plugin",
        pluginName: "Scope Plugin",
        source: "test",
        action: {
          id: "approve",
          requiredScopes: ["operator.approvals"],
          handler: () => ({ result: { ok: true } }),
        },
      },
      {
        pluginId: "scope-plugin",
        pluginName: "Scope Plugin",
        source: "test",
        action: {
          id: "view",
          requiredScopes: ["operator.read"],
          handler: () => ({ result: { ok: true } }),
        },
      },
      {
        pluginId: "scope-plugin",
        pluginName: "Scope Plugin",
        source: "test",
        action: {
          id: "default-write",
          handler: () => ({ result: { ok: true } }),
        },
      },
    ];
    setActivePluginRegistry(registry);

    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("plugins.sessionAction", {
        pluginId: "scope-plugin",
        actionId: "approve",
      }),
    ).toEqual(["operator.approvals"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("plugins.sessionAction", {
        pluginId: " scope-plugin ",
        actionId: " view ",
      }),
    ).toEqual(["operator.read"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("plugins.sessionAction", {
        pluginId: "scope-plugin",
        actionId: "default-write",
      }),
    ).toEqual(["operator.write"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("plugins.sessionAction", {
        pluginId: "scope-plugin",
        actionId: "missing",
      }),
    ).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
      "operator.talk.secrets",
    ]);
    expect(
      authorizeOperatorScopesForMethod("plugins.sessionAction", ["operator.approvals"], {
        pluginId: "scope-plugin",
        actionId: "approve",
      }),
    ).toEqual({ allowed: true });
    expect(
      authorizeOperatorScopesForMethod("plugins.sessionAction", ["operator.write"], {
        pluginId: "scope-plugin",
        actionId: "approve",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.approvals" });
  });

  it("falls back to broad operator scopes when a dynamic session action is not locally registered", () => {
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("plugins.sessionAction", {
        pluginId: "remote-plugin",
        actionId: "approve",
      }),
    ).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
      "operator.talk.secrets",
    ]);
  });

  it("returns empty scopes for unknown methods", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("totally.unknown.method")).toStrictEqual(
      [],
    );
  });

  it("reads plugin-registered gateway method scopes from the active plugin registry", () => {
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["browser.request"] = pluginHandler;
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "browser",
        name: "browser.request",
        handler: pluginHandler,
        scope: "operator.admin",
      }),
    );
    setActivePluginRegistry(registry);

    expect(resolveLeastPrivilegeOperatorScopesForMethod("browser.request")).toEqual([
      "operator.admin",
    ]);
  });

  it("keeps reserved admin namespaces admin-only even if a plugin scope is narrower", () => {
    setPluginGatewayMethodScope(RESERVED_ADMIN_PLUGIN_METHOD, "operator.read");

    expect(resolveLeastPrivilegeOperatorScopesForMethod(RESERVED_ADMIN_PLUGIN_METHOD)).toEqual([
      "operator.admin",
    ]);
  });

  // Regression coverage for #92044: plugin-registered gateway methods were
  // silently requiring operator.admin because resolveScopedMethod only looked at
  // activeRegistry.gatewayMethodDescriptors. The plugin descriptors can live in
  // the http-route or channel surface instead, and a request entering through
  // those surfaces must still see the plugin-declared scope.
  it("resolves a plugin method scope when its descriptor lives on the http route surface", () => {
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["workboard.cards.dispatch"] = pluginHandler;
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "workboard",
        name: "workboard.cards.dispatch",
        handler: pluginHandler,
        scope: "operator.write",
      }),
    );
    setActivePluginRegistry(createEmptyPluginRegistry());
    pinActivePluginHttpRouteRegistry(registry);

    expect(resolveRequiredOperatorScopeForMethod("workboard.cards.dispatch")).toBe(
      "operator.write",
    );
    expect(
      authorizeOperatorScopesForMethod("workboard.cards.dispatch", ["operator.write"]),
    ).toEqual({ allowed: true });
    expect(authorizeOperatorScopesForMethod("workboard.cards.dispatch", ["operator.read"])).toEqual(
      { allowed: false, missingScope: "operator.write" },
    );
  });

  it("resolves a plugin method scope when its descriptor lives on the channel surface", () => {
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["workboard.cards.dispatch"] = pluginHandler;
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "workboard",
        name: "workboard.cards.dispatch",
        handler: pluginHandler,
        scope: "operator.write",
      }),
    );
    setActivePluginRegistry(createEmptyPluginRegistry());
    pinActivePluginChannelRegistry(registry);

    expect(resolveRequiredOperatorScopeForMethod("workboard.cards.dispatch")).toBe(
      "operator.write",
    );
    expect(
      authorizeOperatorScopesForMethod("workboard.cards.dispatch", ["operator.write"]),
    ).toEqual({ allowed: true });
  });

  it("prefers the active surface over http-route or channel surfaces for plugin scopes", () => {
    const httpRouteRegistry = createEmptyPluginRegistry();
    httpRouteRegistry.gatewayHandlers["workboard.cards.dispatch"] = pluginHandler;
    httpRouteRegistry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "workboard",
        name: "workboard.cards.dispatch",
        handler: pluginHandler,
        scope: "operator.read",
      }),
    );
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.gatewayHandlers["workboard.cards.dispatch"] = pluginHandler;
    activeRegistry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "workboard",
        name: "workboard.cards.dispatch",
        handler: pluginHandler,
        scope: "operator.write",
      }),
    );
    setActivePluginRegistry(activeRegistry);
    pinActivePluginHttpRouteRegistry(httpRouteRegistry);

    expect(resolveRequiredOperatorScopeForMethod("workboard.cards.dispatch")).toBe(
      "operator.write",
    );
  });

  it("still returns the admin-scope default for an unknown method when surfaces are empty", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    pinActivePluginHttpRouteRegistry(createEmptyPluginRegistry());
    pinActivePluginChannelRegistry(createEmptyPluginRegistry());

    // Unknown method should fall through to admin via authorizeOperatorScopesForMethod
    // (resolveScopedMethod returns undefined, then the auth check defaults to admin).
    expect(authorizeOperatorScopesForMethod("totally.unknown.method", ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
  });

  // Sibling coverage for #78894 (memory-core dream-promotion cron, same root-cause
  // shape): a memory-core style plugin that registers its method via
  // api.registerGatewayMethod should resolve to its declared scope through the same
  // cross-surface path.
  it("resolves a memory-core style plugin descriptor from the active registry", () => {
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["memory.dream.promote"] = pluginHandler;
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "memory-core",
        name: "memory.dream.promote",
        handler: pluginHandler,
        scope: "operator.write",
      }),
    );
    setActivePluginRegistry(registry);

    expect(resolveRequiredOperatorScopeForMethod("memory.dream.promote")).toBe("operator.write");
    expect(authorizeOperatorScopesForMethod("memory.dream.promote", ["operator.write"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("memory.dream.promote", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.write",
    });
  });

  it("resolves a memory-core style plugin descriptor from the channel surface", () => {
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["memory.dream.promote"] = pluginHandler;
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "memory-core",
        name: "memory.dream.promote",
        handler: pluginHandler,
        scope: "operator.write",
      }),
    );
    setActivePluginRegistry(createEmptyPluginRegistry());
    pinActivePluginChannelRegistry(registry);

    expect(resolveRequiredOperatorScopeForMethod("memory.dream.promote")).toBe("operator.write");
  });
});

describe("operator scope authorization", () => {
  it.each([
    ["health", ["operator.read"], { allowed: true }],
    ["health", ["operator.write"], { allowed: true }],
    ["config.schema.lookup", ["operator.read"], { allowed: true }],
    ["config.schema", ["operator.read"], { allowed: false, missingScope: "operator.admin" }],
    ["config.patch", ["operator.admin"], { allowed: true }],
  ])("authorizes %s for scopes %j", (method, scopes, expected) => {
    expect(authorizeOperatorScopesForMethod(method, scopes)).toEqual(expected);
  });

  it("requires operator.write for write methods", () => {
    expect(authorizeOperatorScopesForMethod("send", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.write",
    });
  });

  it("allows operator.write clients to use unified Talk sessions", () => {
    for (const method of [
      "talk.client.create",
      "talk.client.toolCall",
      "talk.client.steer",
      "talk.session.create",
      "talk.session.join",
      "talk.session.appendAudio",
      "talk.session.startTurn",
      "talk.session.endTurn",
      "talk.session.cancelTurn",
      "talk.session.cancelOutput",
      "talk.session.submitToolResult",
      "talk.session.steer",
      "talk.session.close",
    ]) {
      expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
        allowed: true,
      });
      expect(authorizeOperatorScopesForMethod(method, ["operator.read"])).toEqual({
        allowed: false,
        missingScope: "operator.write",
      });
    }
  });

  it("requires admin for browser.request", () => {
    setPluginGatewayMethodScope("browser.request", "operator.admin");

    expect(authorizeOperatorScopesForMethod("browser.request", ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
    expect(authorizeOperatorScopesForMethod("browser.request", ["operator.admin"])).toEqual({
      allowed: true,
    });
  });

  it("requires pairing scope for node pairing approvals", () => {
    expect(authorizeOperatorScopesForMethod("node.pair.approve", ["operator.pairing"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("node.pair.approve", ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.pairing",
    });
  });

  it.each(["exec.approval.get", "exec.approval.list", "exec.approval.resolve"])(
    "requires approvals scope for %s",
    (method) => {
      expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
        allowed: false,
        missingScope: "operator.approvals",
      });
      expect(authorizeOperatorScopesForMethod(method, ["operator.approvals"])).toEqual({
        allowed: true,
      });
    },
  );

  it.each([
    "exec.approvals.get",
    "exec.approvals.set",
    "exec.approvals.node.get",
    "exec.approvals.node.set",
  ])("requires admin scope for exec approval policy method %s", (method) => {
    expect(authorizeOperatorScopesForMethod(method, ["operator.approvals"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
    expect(authorizeOperatorScopesForMethod(method, ["operator.admin"])).toEqual({
      allowed: true,
    });
  });

  it.each([
    "plugin.approval.list",
    "plugin.approval.request",
    "plugin.approval.waitDecision",
    "plugin.approval.resolve",
  ])("requires approvals scope for %s", (method) => {
    expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.approvals",
    });
    expect(authorizeOperatorScopesForMethod(method, ["operator.approvals"])).toEqual({
      allowed: true,
    });
  });

  it("requires admin for unknown methods", () => {
    expect(authorizeOperatorScopesForMethod("unknown.method", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
  });

  it("requires admin for reserved admin namespaces even if a plugin registered a narrower scope", () => {
    setPluginGatewayMethodScope(RESERVED_ADMIN_PLUGIN_METHOD, "operator.read");

    expect(
      authorizeOperatorScopesForMethod(RESERVED_ADMIN_PLUGIN_METHOD, ["operator.read"]),
    ).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
  });
});

describe("plugin approval method registration", () => {
  it("lists all plugin approval methods", () => {
    const methods = listGatewayMethods();
    expect(methods).toContain("plugin.approval.list");
    expect(methods).toContain("plugin.approval.request");
    expect(methods).toContain("plugin.approval.waitDecision");
    expect(methods).toContain("plugin.approval.resolve");
  });

  it("classifies plugin approval methods", () => {
    expect(isGatewayMethodClassified("plugin.approval.list")).toBe(true);
    expect(isGatewayMethodClassified("plugin.approval.request")).toBe(true);
    expect(isGatewayMethodClassified("plugin.approval.waitDecision")).toBe(true);
    expect(isGatewayMethodClassified("plugin.approval.resolve")).toBe(true);
  });
});

describe("core gateway method classification", () => {
  it("treats node-role methods as classified even without operator scopes", () => {
    expect(isGatewayMethodClassified("node.pending.drain")).toBe(true);
    expect(isGatewayMethodClassified("node.pending.pull")).toBe(true);
    expect(isGatewayMethodClassified("node.pluginSurface.refresh")).toBe(true);
  });

  it("classifies every exposed core gateway handler method", () => {
    const unclassified = Object.keys(coreGatewayHandlers).filter(
      (method) => !isGatewayMethodClassified(method),
    );
    expect(unclassified).toStrictEqual([]);
  });

  it("classifies every listed gateway method name", () => {
    const unclassified = listGatewayMethods().filter(
      (method) => !isGatewayMethodClassified(method),
    );
    expect(unclassified).toStrictEqual([]);
  });

  it("exposes skill proposal methods through the core gateway registry", () => {
    for (const method of ["skills.proposals.list", "skills.proposals.inspect"]) {
      expect(listGatewayMethods()).toContain(method);
      expect(coreGatewayHandlers).toHaveProperty(method);
      expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual(["operator.read"]);
      expect(authorizeOperatorScopesForMethod(method, ["operator.read"])).toEqual({
        allowed: true,
      });
    }

    for (const method of [
      "skills.proposals.create",
      "skills.proposals.update",
      "skills.proposals.revise",
      "skills.proposals.apply",
      "skills.proposals.reject",
      "skills.proposals.quarantine",
    ]) {
      expect(listGatewayMethods()).toContain(method);
      expect(coreGatewayHandlers).toHaveProperty(method);
      expect(resolveLeastPrivilegeOperatorScopesForMethod(method)).toEqual(["operator.admin"]);
      expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
        allowed: false,
        missingScope: "operator.admin",
      });
      expect(authorizeOperatorScopesForMethod(method, ["operator.admin"])).toEqual({
        allowed: true,
      });
    }
  });
});

describe("CLI default operator scopes", () => {
  it("includes operator.talk.secrets for node-role device pairing approvals", async () => {
    const { CLI_DEFAULT_OPERATOR_SCOPES } = await import("./method-scopes.js");
    expect(CLI_DEFAULT_OPERATOR_SCOPES).toContain("operator.talk.secrets");
  });
});
