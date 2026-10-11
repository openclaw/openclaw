/**
 * Gateway method-scope policy tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveSessionMethodScope } from "../shared/session-method-scopes-base.js";
import {
  authorizeOperatorScopesForMethod,
  authorizeOperatorScopesForRequiredScope,
  isGatewayMethodClassified,
  projectOperatorScopesForMethod,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./method-scopes.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createExpectedBroadOperatorScopes } from "./scope-expectations.test-support.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

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

describe("method scope resolution and authorization", () => {
  it("requires write scope for runtime-aware inventory", () => {
    const params = { runtimeId: "openclaw" };
    expect(
      authorizeOperatorScopesForMethod("environments.list", ["operator.read"], params),
    ).toEqual({
      allowed: false,
      missingScope: "operator.write",
    });
    expect(
      authorizeOperatorScopesForMethod("environments.list", ["operator.write"], params),
    ).toEqual({ allowed: true });
  });

  it("keeps inventory without a runtime ID read-scoped", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("environments.list")).toEqual([
      "operator.read",
    ]);
  });

  it("leaves node-only pending drain outside operator scopes", () => {
    expect(isGatewayMethodClassified("node.pending.drain")).toBe(true);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("node.pending.drain")).toStrictEqual([]);
  });

  it("raises agent reset commands from write to admin scope", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("agent", { message: "hello" })).toEqual([
      "operator.write",
    ]);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("agent", { message: "/reset" })).toEqual([
      "operator.admin",
    ]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("agent", { message: "/new follow up" }),
    ).toEqual(["operator.admin"]);
    expect(
      authorizeOperatorScopesForMethod("agent", ["operator.write"], { message: "/reset" }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
  });

  it("raises host-sensitive node commands from write to admin scope", () => {
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("node.invoke", { command: "device.info" }),
    ).toEqual(["operator.write"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("node.invoke", { command: "browser.proxy" }),
    ).toEqual(["operator.admin"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("node.invoke", {
        command: "browser.proxy.upload.v1",
      }),
    ).toEqual(["operator.admin"]);
    expect(
      authorizeOperatorScopesForMethod("node.invoke", ["operator.write"], {
        command: "fs.listDir",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("node.invoke", {
        command: "browser.proxy.upload.v1",
        params: { method: "POST", path: "/profiles/create" },
      }),
    ).toEqual(["operator.write"]);
  });

  it("adds talk secret scope only when unredacted config is requested", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("talk.config", {})).toEqual([
      "operator.read",
    ]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("talk.config", { includeSecrets: true }),
    ).toEqual(["operator.read", "operator.talk.secrets"]);
    expect(
      authorizeOperatorScopesForMethod("talk.config", ["operator.read"], {
        includeSecrets: true,
      }),
    ).toEqual({ allowed: false, missingScope: "operator.talk.secrets" });
    expect(
      authorizeOperatorScopesForMethod("talk.config", ["operator.read", "operator.talk.secrets"], {
        includeSecrets: true,
      }),
    ).toEqual({ allowed: true });
  });

  it("accepts dedicated Talk access and preserves operator.write compatibility", () => {
    expect(authorizeOperatorScopesForMethod("talk.client.create", ["operator.talk"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("talk.client.create", ["operator.write"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("talk.client.create", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.talk",
    });
  });

  it("requires admin only when DM pairing approval bootstraps a command owner", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("channels.pairing.approve", {})).toEqual([
      "operator.pairing",
    ]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("channels.pairing.approve", {
        bootstrapCommandOwner: true,
      }),
    ).toEqual(["operator.pairing", "operator.admin"]);
    expect(
      authorizeOperatorScopesForMethod("channels.pairing.approve", ["operator.pairing"], {
        bootstrapCommandOwner: true,
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    expect(
      authorizeOperatorScopesForMethod(
        "channels.pairing.approve",
        ["operator.pairing", "operator.admin"],
        { bootstrapCommandOwner: true },
      ),
    ).toEqual({ allowed: true });
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
    ).toEqual(createExpectedBroadOperatorScopes());
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

  it("defers Gateway cwd containment to sessions.create while keeping node cwd admin-only", () => {
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", { worktree: true }),
    ).toEqual(["operator.write"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", { cwd: "/other/repo" }),
    ).toEqual(["operator.write"]);
    expect(
      authorizeOperatorScopesForMethod("sessions.create", ["operator.write"], {
        cwd: "/other/repo",
      }),
    ).toEqual({ allowed: true });
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", {
        worktree: true,
        cwd: "/other/repo",
      }),
    ).toEqual(["operator.write"]);
    expect(
      authorizeOperatorScopesForMethod("sessions.create", ["operator.write"], {
        worktree: true,
        cwd: "/other/repo",
      }),
    ).toEqual({ allowed: true });
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", {
        execNode: "macbook",
        cwd: "/other/repo",
      }),
    ).toEqual(["operator.admin"]);
  });

  it("keeps Gateway fs.listDir write-scoped and node browsing admin-only", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("fs.listDir", {})).toEqual([
      "operator.write",
    ]);
    expect(
      authorizeOperatorScopesForMethod("fs.listDir", ["operator.write"], {
        path: "/configured/workspace",
      }),
    ).toEqual({ allowed: true });
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("fs.listDir", { nodeId: "macbook" }),
    ).toEqual(["operator.admin"]);
    expect(
      authorizeOperatorScopesForMethod("fs.listDir", ["operator.write"], {
        nodeId: "macbook",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
  });

  it.each([
    [
      "device dispatch",
      "sessions.dispatch",
      { key: "agent:main:thread", deviceId: "device-1" },
      "operator.write",
    ],
    [
      "profile dispatch",
      "sessions.dispatch",
      { key: "agent:main:thread", profileId: "development" },
      "operator.admin",
    ],
    [
      "gateway move",
      "sessions.move",
      {
        key: "agent:main:thread",
        expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
        target: { kind: "gateway" },
      },
      "operator.write",
    ],
    [
      "profile move",
      "sessions.move",
      {
        key: "agent:main:thread",
        expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
        target: { kind: "profile", profileId: "development" },
      },
      "operator.admin",
    ],
  ] as const)(
    "derives %s authorization from its placement target",
    (_name, method, params, scope) => {
      expect(resolveLeastPrivilegeOperatorScopesForMethod(method, params)).toEqual([scope]);
      expect(authorizeOperatorScopesForMethod(method, [scope], params)).toEqual({ allowed: true });
      if (scope === "operator.admin") {
        expect(authorizeOperatorScopesForMethod(method, ["operator.write"], params)).toEqual({
          allowed: false,
          missingScope: "operator.admin",
        });
      }
    },
  );

  it.each([
    [
      "sessions.dispatch",
      { key: "agent:main:thread", profileId: "development", deviceId: "device-1" },
    ],
    ["sessions.move", { key: "agent:main:thread", target: { kind: "profile" } }],
  ] as const)("keeps malformed %s params write-scoped for handler validation", (method, params) => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod(method, params)).toEqual([
      "operator.write",
    ]);
    expect(authorizeOperatorScopesForMethod(method, ["operator.write"], params)).toEqual({
      allowed: true,
    });
  });

  it("requires admin for sensitive session creation parameters", () => {
    const incognitoKey = "agent:main:dashboard:incognito-parent";
    for (const params of [
      { agentId: "main", incognito: true },
      { key: incognitoKey },
      { parentSessionKey: incognitoKey },
      { agentId: "main", toolOverrides: { skills: { release: false } } },
    ]) {
      const required = resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", params);
      expect(required).toEqual(["operator.admin"]);
      expect(
        authorizeOperatorScopesForMethod("sessions.create", ["operator.write"], params),
      ).toEqual({ allowed: false, missingScope: "operator.admin" });
      expect(
        authorizeOperatorScopesForMethod("sessions.create", ["operator.admin"], params),
      ).toEqual({ allowed: true });
    }
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.create", { incognito: false }),
    ).toEqual(["operator.write"]);
  });

  it("lets malformed sessions.patch params through to handler validation at write scope", () => {
    // Malformed params cannot mutate anything; the handler rejects them with a
    // precise validation error instead of a misleading missing-scope error.
    expect(authorizeOperatorScopesForMethod("sessions.patch", ["operator.write"])).toEqual({
      allowed: true,
    });
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.patch")).toEqual([
      "operator.write",
    ]);
  });

  it("grants write-scope sessions.delete only with the archivedOnly opt-in", () => {
    // Internal callers (subagent cleanup, fallback synthetic dispatch, CLI
    // minting) never set archivedOnly and keep requiring admin; the handler
    // enforces that archivedOnly targets are actually archived.
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.delete")).toEqual([
      "operator.admin",
    ]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.delete", {
        key: "agent:main:old",
        deleteTranscript: true,
      }),
    ).toEqual(["operator.admin"]);
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.delete", {
        key: "agent:main:old",
        archivedOnly: true,
      }),
    ).toEqual(["operator.write"]);
    const archivedParams = { key: "agent:main:old", archivedOnly: true };
    expect(
      authorizeOperatorScopesForMethod("sessions.delete", ["operator.write"], archivedParams),
    ).toEqual({ allowed: true });
    expect(
      authorizeOperatorScopesForMethod("sessions.delete", ["operator.read"], archivedParams),
    ).toEqual({ allowed: false, missingScope: "operator.write" });
    expect(
      authorizeOperatorScopesForMethod("sessions.delete", ["operator.write"], {
        key: "agent:main:old",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    expect(
      authorizeOperatorScopesForMethod("sessions.delete", ["operator.write"], {
        key: "agent:main:old",
        archivedOnly: "yes",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    // Internal-only controls must not ride along on the write-scope path.
    expect(
      authorizeOperatorScopesForMethod("sessions.delete", ["operator.write"], {
        key: "agent:main:old",
        archivedOnly: true,
        emitLifecycleHooks: false,
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    expect(
      authorizeOperatorScopesForMethod("sessions.delete", ["operator.write"], {
        key: "agent:main:old",
        archivedOnly: true,
        expectedSessionId: "sess-1",
      }),
    ).toEqual({ allowed: true });
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.delete", {
        key: "agent:main:old",
        archivedOnly: true,
        expectedSessionId: "sess-1",
      }),
    ).toEqual(["operator.write"]);
    expect(
      authorizeOperatorScopesForMethod("sessions.delete", ["operator.write"], {
        key: "agent:main:old",
        archivedOnly: true,
        expectedSessionId: "sess-1",
        futureField: true,
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("sessions.delete", {
        key: "agent:main:old",
        archivedOnly: true,
        emitLifecycleHooks: false,
      }),
    ).toEqual(["operator.admin"]);
    expect(authorizeOperatorScopesForMethod("sessions.delete", ["operator.admin"])).toEqual({
      allowed: true,
    });
  });

  it("requires admin for browser.request", () => {
    setPluginGatewayMethodScope("browser.request", "operator.admin");

    expect(resolveLeastPrivilegeOperatorScopesForMethod("browser.request")).toEqual([
      "operator.admin",
    ]);
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

  it("requires approvals scope to resolve approvals", () => {
    const method = "approval.resolve";
    expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.approvals",
    });
    expect(authorizeOperatorScopesForMethod(method, ["operator.approvals"])).toEqual({
      allowed: true,
    });
  });

  it("keeps broad question authority distinct from own-run admission", () => {
    const method = "question.resolve";
    expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
      allowed: true,
      sessionScope: "operator.sessions.write",
    });
    expect(authorizeOperatorScopesForMethod(method, ["operator.questions"])).toEqual({
      allowed: true,
    });
  });

  it("requires admin for unknown methods", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("unknown.method")).toStrictEqual([]);
    expect(authorizeOperatorScopesForMethod("unknown.method", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
  });

  it("requires admin for reserved admin namespaces even if a plugin registered a narrower scope", () => {
    setPluginGatewayMethodScope(RESERVED_ADMIN_PLUGIN_METHOD, "operator.read");

    expect(resolveLeastPrivilegeOperatorScopesForMethod(RESERVED_ADMIN_PLUGIN_METHOD)).toEqual([
      "operator.admin",
    ]);
    expect(
      authorizeOperatorScopesForMethod(RESERVED_ADMIN_PLUGIN_METHOD, ["operator.read"]),
    ).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
  });

  it("exposes skill proposal methods through the core gateway registry", () => {
    for (const method of [
      "skills.proposals.list",
      "skills.proposals.events.list",
      "skills.proposals.inspect",
      "skills.proposals.historyStatus",
    ]) {
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
      "skills.proposals.evaluate",
      "skills.proposals.historyScan",
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

  it("keeps permission CAS write-scoped while full remains admin-only", () => {
    const guarded = {
      key: "agent:main:ios-1",
      expectedPermissionMode: "read-only",
      permissionMode: "guarded",
    };
    expect(resolveLeastPrivilegeOperatorScopesForMethod("sessions.patch", guarded)).toEqual([
      "operator.write",
    ]);
    expect(authorizeOperatorScopesForMethod("sessions.patch", ["operator.write"], guarded)).toEqual(
      {
        allowed: true,
      },
    );
    expect(
      authorizeOperatorScopesForMethod("sessions.patch", ["operator.write"], {
        ...guarded,
        permissionMode: "full",
      }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
  });
});

describe("session-scoped method admission", () => {
  it.each([
    ["sessions.describe", { key: "agent:main:requester" }, { allowed: true }],
    ["send", { sessionKey: "agent:main:requester" }, { allowed: true }],
    [
      "chat.inject",
      { sessionKey: "agent:main:requester" },
      { allowed: false, missingScope: "operator.admin" },
    ],
  ] as const)(
    "checks requester delivery method %s against the real plugin client grant",
    (method, params, expected) => {
      const client = createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "voice-call" });
      expect(authorizeOperatorScopesForMethod(method, client.connect.scopes ?? [], params)).toEqual(
        expected,
      );
    },
  );

  it.each([
    ["canvas.document.preview", { html: "<p>Preview</p>" }, true],
    ["models.list", {}, true],
    ["chat.history", { sessionKey: "agent:main:own" }, true],
    [
      "sessions.files.assets",
      { sessionKey: "agent:main:own", path: "index.html", refs: ["a.png"] },
      true,
    ],
    ["config.get", undefined, false],
    ["canvas.document.view", undefined, false],
  ] as const)(
    "restricts the narrow read alternative to session and bootstrap methods: %s",
    (method, params, narrow) => {
      for (const scopes of [
        ["operator.sessions.read"],
        ["operator.sessions.write"],
        ["operator.sessions.read", "operator.sessions.write"],
      ]) {
        expect(authorizeOperatorScopesForMethod(method, scopes, params)).toEqual(
          narrow
            ? { allowed: true, sessionScope: "operator.sessions.read" }
            : { allowed: false, missingScope: "operator.read" },
        );
      }
      if (!narrow) {
        return;
      }
      for (const scope of ["operator.read", "operator.write", "operator.admin"]) {
        expect(
          authorizeOperatorScopesForMethod(method, [scope, "operator.sessions.read"], params),
        ).toEqual({ allowed: true });
      }
      for (const allowed of ["operator.sessions.read", "operator.sessions.write"]) {
        expect(
          projectOperatorScopesForMethod({
            method,
            requestParams: params,
            requestedScopes: ["operator.read", "operator.admin"],
            allowedScopes: [allowed],
          }),
        ).toEqual(["operator.sessions.read"]);
      }
    },
  );

  it.each([
    ["chat.send", { sessionKey: "agent:main:own", message: "hello" }, "operator.write"],
    ["sessions.create", {}, "operator.write"],
    ["sessions.patch", { key: "agent:main:own", label: "updated" }, "operator.write"],
    [
      "sessions.patchMany",
      { targets: [{ key: "agent:main:own" }], patch: { unread: true } },
      "operator.write",
    ],
    ["question.resolve", {}, "operator.questions"],
  ] as const)("requires the narrow write grant for %s", (method, params, broad) => {
    expect(authorizeOperatorScopesForMethod(method, ["operator.sessions.write"], params)).toEqual({
      allowed: true,
      sessionScope: "operator.sessions.write",
    });
    expect(authorizeOperatorScopesForMethod(method, ["operator.sessions.read"], params)).toEqual({
      allowed: false,
      missingScope: broad,
    });
    expect(authorizeOperatorScopesForMethod(method, [broad], params)).toEqual({
      allowed: true,
    });
    expect(
      projectOperatorScopesForMethod({
        method,
        requestParams: params,
        requestedScopes: [
          broad,
          "operator.approvals",
          ...(broad === "operator.questions" ? ["operator.admin"] : []),
        ],
        allowedScopes: ["operator.sessions.write"],
      }),
    ).toEqual(["operator.sessions.write"]);
  });

  it.each([
    ["sessions.create", { incognito: true }],
    ["sessions.create", { key: "agent:main:dashboard:incognito-secret" }],
    ["sessions.create", { parentSessionKey: "agent:main:dashboard:incognito-secret" }],
    ["sessions.create", { execNode: "remote" }],
    ["sessions.create", { toolOverrides: { allow: [] } }],
    ["sessions.create", { permissionMode: "full" }],
    ["sessions.patch", { key: "agent:main:own", permissionMode: "full" }],
    ["sessions.patchMany", { targets: [{ key: "agent:main:own" }], patch: { sandboxMode: "off" } }],
    ["sessions.patch", { key: "agent:main:own", unknownMutation: true }],
    ["sessions.delete", { key: "agent:main:own" }],
    ["sessions.delete", { key: "agent:main:own", archivedOnly: true }],
    ["agent", { message: "/reset" }],
    ["tools.invoke", {}],
    ["plugins.sessionAction", { pluginId: "custom", actionId: "protected" }],
  ] as const)("does not turn the session grant into broader authority for %s", (method, params) => {
    expect(
      authorizeOperatorScopesForMethod(method, ["operator.sessions.write"], params),
    ).toMatchObject({ allowed: false });
    expect(
      projectOperatorScopesForMethod({
        method,
        requestParams: params,
        requestedScopes: ["operator.write", "operator.admin", "operator.questions"],
        allowedScopes: ["operator.sessions.write"],
      }),
    ).toEqual([]);
    if (method === "sessions.delete" && "archivedOnly" in params) {
      expect(authorizeOperatorScopesForMethod(method, ["operator.write"], params)).toEqual({
        allowed: true,
      });
    }
  });

  it("preserves a dispatch registry's stronger scope and does not borrow broad read for a write", () => {
    for (const requiredScope of [
      "operator.admin",
      "operator.approvals",
      "operator.questions",
    ] as const) {
      expect(
        projectOperatorScopesForMethod({
          method: "sessions.patch",
          requestParams: { label: "updated" },
          requestedScopes: ["operator.write"],
          allowedScopes: ["operator.sessions.write"],
          requiredScope,
        }),
      ).toEqual([]);
    }
    for (const required of ["operator.read", "operator.approvals"] as const) {
      expect(
        authorizeOperatorScopesForRequiredScope(required, [required, "operator.sessions.write"]),
      ).toEqual({ allowed: true });
    }
    expect(
      authorizeOperatorScopesForRequiredScope(
        "operator.admin",
        ["operator.sessions.write"],
        resolveSessionMethodScope("sessions.patch", { label: "updated" }),
      ),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    expect(
      authorizeOperatorScopesForRequiredScope(
        "operator.write",
        ["operator.sessions.read"],
        resolveSessionMethodScope("sessions.list"),
      ),
    ).toEqual({ allowed: false, missingScope: "operator.write" });
    expect(
      authorizeOperatorScopesForMethod("sessions.patch", ["operator.read"], { label: "updated" }),
    ).toEqual({ allowed: false, missingScope: "operator.write" });
  });
});
