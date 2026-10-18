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

const required = (...args: Parameters<typeof resolveLeastPrivilegeOperatorScopesForMethod>) =>
  expect(resolveLeastPrivilegeOperatorScopesForMethod(...args));
const admission = (...args: Parameters<typeof authorizeOperatorScopesForMethod>) =>
  expect(authorizeOperatorScopesForMethod(...args));
const scopeAdmission = (...args: Parameters<typeof authorizeOperatorScopesForRequiredScope>) =>
  expect(authorizeOperatorScopesForRequiredScope(...args));
const projection = (...args: Parameters<typeof projectOperatorScopesForMethod>) =>
  expect(projectOperatorScopesForMethod(...args));

function allow(...args: Parameters<typeof authorizeOperatorScopesForMethod>) {
  admission(...args).toEqual({ allowed: true });
}
function deny(missingScope: string, ...args: Parameters<typeof authorizeOperatorScopesForMethod>) {
  admission(...args).toEqual({ allowed: false, missingScope });
}
function expectScope(
  scope: string,
  ...args: Parameters<typeof resolveLeastPrivilegeOperatorScopesForMethod>
) {
  required(...args).toEqual([scope]);
}
function expectAccess(scope: string, method: string, params?: unknown, deniedScope?: string) {
  expectScope(scope, method, params);
  allow(method, [scope], params);
  if (deniedScope) {
    deny(scope, method, [deniedScope], params);
  }
}

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
  it("admits workspace refresh and metadata edits while retaining full-write admission for lifecycle actions", () => {
    for (const action of ["refresh_base", "edit"]) {
      allow("sessions.github.action", ["operator.sessions.write"], { action });
    }
    for (const action of ["inspect", "ready", "merge", "close", "unknown"]) {
      deny("operator.write", "sessions.github.action", ["operator.sessions.write"], {
        action,
      });
    }
  });
  it("keeps private background mutations under ordinary write scope", () => {
    expectScope("operator.read", "users.background.get");
    for (const method of ["users.background.upload", "users.background.remove"]) {
      expectAccess("operator.write", method, undefined, "operator.read");
    }
  });

  it("requires write scope for runtime-aware inventory", () => {
    const params = { runtimeId: "openclaw" };
    deny("operator.write", "environments.list", ["operator.read"], params);
    allow("environments.list", ["operator.write"], params);
  });

  it("leaves node-only pending drain outside operator scopes", () => {
    expect(isGatewayMethodClassified("node.pending.drain")).toBe(true);
    required("node.pending.drain").toStrictEqual([]);
  });

  it("raises agent reset commands from write to admin scope", () => {
    expectScope("operator.write", "agent", { message: "hello" });
    expectScope("operator.admin", "agent", { message: "/reset" });
    expectScope("operator.admin", "agent", { message: "/new follow up" });
    deny("operator.admin", "agent", ["operator.write"], { message: "/reset" });
  });

  it("raises host-sensitive node commands from write to admin scope", () => {
    expectScope("operator.write", "node.invoke", { command: "device.info" });
    expectScope("operator.admin", "node.invoke", { command: "browser.proxy" });
    expectScope("operator.admin", "node.invoke", {
      command: "browser.proxy.upload.v1",
    });
    deny("operator.admin", "node.invoke", ["operator.write"], {
      command: "fs.listDir",
    });
    expectScope("operator.write", "node.invoke", {
      command: "browser.proxy.upload.v1",
      params: { method: "POST", path: "/profiles/create" },
    });
  });

  it("adds talk secret scope only when unredacted config is requested", () => {
    const params = { includeSecrets: true };
    expectScope("operator.read", "talk.config", {});
    const scopes = ["operator.read", "operator.talk.secrets"];
    required("talk.config", params).toEqual(scopes);
    deny("operator.talk.secrets", "talk.config", ["operator.read"], params);
    allow("talk.config", scopes, params);
  });

  it("accepts dedicated Talk access and preserves operator.write compatibility", () => {
    allow("talk.client.create", ["operator.talk"]);
    allow("talk.client.create", ["operator.write"]);
    deny("operator.talk", "talk.client.create", ["operator.read"]);
  });

  it("requires admin only when DM pairing approval bootstraps a command owner", () => {
    const params = { bootstrapCommandOwner: true };
    const scopes = ["operator.pairing", "operator.admin"];
    expectScope("operator.pairing", "channels.pairing.approve", {});
    required("channels.pairing.approve", params).toEqual(scopes);
    deny("operator.admin", "channels.pairing.approve", ["operator.pairing"], params);
    allow("channels.pairing.approve", scopes, params);
  });

  it("classifies plugin session actions with a CLI-safe default operator scope", () => {
    expectScope("operator.write", "plugins.sessionAction");
    expect(isGatewayMethodClassified("plugins.sessionAction")).toBe(true);
    deny("operator.write", "plugins.sessionAction", ["operator.read"]);
  });

  it("derives least-privilege scopes from registered plugin session action params", () => {
    const registry = createEmptyPluginRegistry();
    type Action = (typeof registry.sessionActions)[number]["action"];
    const makeAction = (id: string, requiredScopes?: Action["requiredScopes"]): Action => ({
      id,
      ...(requiredScopes ? { requiredScopes } : {}),
      handler: () => ({ result: { ok: true } }),
    });
    registry.sessionActions = [
      makeAction("approve", ["operator.approvals"]),
      makeAction("view", ["operator.read"]),
      makeAction("default-write"),
    ].map((action) => ({
      pluginId: "scope-plugin",
      pluginName: "Scope Plugin",
      source: "test",
      action,
    }));
    setActivePluginRegistry(registry);

    const approve = { pluginId: "scope-plugin", actionId: "approve" };
    expectAccess("operator.approvals", "plugins.sessionAction", approve, "operator.write");
    expectScope("operator.read", "plugins.sessionAction", {
      pluginId: " scope-plugin ",
      actionId: " view ",
    });
    expectScope("operator.write", "plugins.sessionAction", {
      pluginId: "scope-plugin",
      actionId: "default-write",
    });
    required("plugins.sessionAction", {
      pluginId: "scope-plugin",
      actionId: "missing",
    }).toEqual(createExpectedBroadOperatorScopes());
  });

  it("defers Gateway cwd containment to sessions.create while keeping node cwd admin-only", () => {
    expectScope("operator.write", "sessions.create", { worktree: true });
    for (const params of [{ cwd: "/other/repo" }, { worktree: true, cwd: "/other/repo" }]) {
      expectAccess("operator.write", "sessions.create", params);
    }
    expectScope("operator.admin", "sessions.create", {
      execNode: "macbook",
      cwd: "/other/repo",
    });
  });

  it("requires operator.write rather than own-session scope for device folders", () => {
    const params = { deviceFolder: { deviceId: "paired-device", path: "~/project" } };
    expectAccess("operator.write", "sessions.create", params, "operator.sessions.write");
  });

  it("keeps Gateway fs.listDir write-scoped and node browsing admin-only", () => {
    expectScope("operator.write", "fs.listDir", {});
    allow("fs.listDir", ["operator.write"], {
      path: "/configured/workspace",
    });
    const nodeParams = { nodeId: "macbook" };
    expectScope("operator.admin", "fs.listDir", nodeParams);
    deny("operator.admin", "fs.listDir", ["operator.write"], nodeParams);
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
      expectAccess(
        scope,
        method,
        params,
        scope === "operator.admin" ? "operator.write" : undefined,
      );
    },
  );

  it("requires admin for sensitive session creation parameters", () => {
    const incognitoKey = "agent:main:dashboard:incognito-parent";
    for (const params of [
      { agentId: "main", incognito: true },
      { key: incognitoKey },
      { parentSessionKey: incognitoKey },
      { agentId: "main", toolOverrides: { skills: { release: false } } },
    ]) {
      expectAccess("operator.admin", "sessions.create", params, "operator.write");
    }
    expectScope("operator.write", "sessions.create", { incognito: false });
  });

  it("grants write-scope sessions.delete only with the archivedOnly opt-in", () => {
    expectScope("operator.admin", "sessions.delete");
    expectScope("operator.admin", "sessions.delete", {
      key: "agent:main:old",
      deleteTranscript: true,
    });
    const archivedParams = { key: "agent:main:old", archivedOnly: true };
    expectAccess("operator.write", "sessions.delete", archivedParams, "operator.read");
    for (const params of [
      { key: archivedParams.key },
      { ...archivedParams, archivedOnly: "yes" },
      { ...archivedParams, emitLifecycleHooks: false },
      { ...archivedParams, expectedSessionId: "sess-1", futureField: true },
    ]) {
      deny("operator.admin", "sessions.delete", ["operator.write"], params);
    }
    expectAccess("operator.write", "sessions.delete", {
      ...archivedParams,
      expectedSessionId: "sess-1",
    });
    expectScope("operator.admin", "sessions.delete", {
      ...archivedParams,
      emitLifecycleHooks: false,
    });
    allow("sessions.delete", ["operator.admin"]);
  });

  it("requires admin for browser.request", () => {
    setPluginGatewayMethodScope("browser.request", "operator.admin");

    expectAccess("operator.admin", "browser.request", undefined, "operator.write");
  });

  it("requires pairing scope for node pairing approvals", () => {
    allow("node.pair.approve", ["operator.pairing"]);
    deny("operator.pairing", "node.pair.approve", ["operator.write"]);
  });

  it("requires approvals scope to resolve approvals", () => {
    const method = "approval.resolve";
    deny("operator.approvals", method, ["operator.write"]);
    allow(method, ["operator.approvals"]);
  });

  it("keeps broad question authority distinct from own-run admission", () => {
    const method = "question.resolve";
    admission(method, ["operator.write"]).toEqual({
      allowed: true,
      sessionScope: "operator.sessions.write",
    });
    allow(method, ["operator.questions"]);
  });

  it("requires admin for unknown methods", () => {
    required("unknown.method").toStrictEqual([]);
    deny("operator.admin", "unknown.method", ["operator.read"]);
  });

  it("requires admin for reserved admin namespaces even if a plugin registered a narrower scope", () => {
    setPluginGatewayMethodScope(RESERVED_ADMIN_PLUGIN_METHOD, "operator.read");

    expectScope("operator.admin", RESERVED_ADMIN_PLUGIN_METHOD);
    deny("operator.admin", RESERVED_ADMIN_PLUGIN_METHOD, ["operator.read"]);
  });

  it("exposes skill proposal methods through the core gateway registry", () => {
    for (const [scope, names] of [
      ["operator.read", ["list", "events.list", "inspect", "historyStatus"]],
      [
        "operator.admin",
        ["create", "update", "revise", "evaluate", "historyScan", "apply", "reject", "quarantine"],
      ],
    ] as const) {
      for (const name of names) {
        const method = `skills.proposals.${name}`;
        expect(listGatewayMethods()).toContain(method);
        expect(coreGatewayHandlers).toHaveProperty(method);
        expectAccess(
          scope,
          method,
          undefined,
          scope === "operator.admin" ? "operator.write" : undefined,
        );
      }
    }
  });

  it("keeps permission CAS write-scoped while full remains admin-only", () => {
    const guarded = {
      key: "agent:main:ios-1",
      expectedPermissionMode: "read-only",
      permissionMode: "guarded",
    };
    expectAccess("operator.write", "sessions.patch", guarded);
    deny("operator.admin", "sessions.patch", ["operator.write"], {
      ...guarded,
      permissionMode: "full",
    });
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
      admission(method, client.connect.scopes ?? [], params).toEqual(expected);
    },
  );

  it.each([
    ["sessions.diff", { sessionKey: "agent:main:own" }, true],
    [
      "sessions.files.assets",
      { sessionKey: "agent:main:own", path: "index.html", refs: ["a.png"] },
      true,
    ],
    ["config.get", undefined, false],
  ] as const)(
    "restricts the narrow read alternative to session and bootstrap methods: %s",
    (method, params, narrow) => {
      for (const scopes of [
        ["operator.sessions.read"],
        ["operator.sessions.write"],
        ["operator.sessions.read", "operator.sessions.write"],
      ]) {
        admission(method, scopes, params).toEqual(
          narrow
            ? { allowed: true, sessionScope: "operator.sessions.read" }
            : { allowed: false, missingScope: "operator.read" },
        );
      }
      if (!narrow) {
        return;
      }
      for (const scope of ["operator.read", "operator.write", "operator.admin"]) {
        allow(method, [scope, "operator.sessions.read"], params);
      }
      for (const allowed of ["operator.sessions.read", "operator.sessions.write"]) {
        projection({
          method,
          requestParams: params,
          requestedScopes: ["operator.read", "operator.admin"],
          allowedScopes: [allowed],
        }).toEqual(["operator.sessions.read"]);
      }
    },
  );

  it.each([
    ["chat.send", { sessionKey: "agent:main:own", message: "hello" }, "operator.write"],
    ["question.resolve", {}, "operator.questions"],
  ] as const)("requires the narrow write grant for %s", (method, params, broad) => {
    admission(method, ["operator.sessions.write"], params).toEqual({
      allowed: true,
      sessionScope: "operator.sessions.write",
    });
    admission(method, ["operator.sessions.read"], params).toEqual({
      allowed: false,
      missingScope: broad,
    });
    allow(method, [broad], params);
    projection({
      method,
      requestParams: params,
      requestedScopes: [
        broad,
        "operator.approvals",
        ...(broad === "operator.questions" ? ["operator.admin"] : []),
      ],
      allowedScopes: ["operator.sessions.write"],
    }).toEqual(["operator.sessions.write"]);
  });

  it.each([
    ["sessions.create", { incognito: true }],
    ["sessions.patch", { key: "agent:main:own", permissionMode: "full" }],
    ["sessions.patchMany", { targets: [{ key: "agent:main:own" }], patch: { sandboxMode: "off" } }],
    ["sessions.patch", { key: "agent:main:own", unknownMutation: true }],
    ["sessions.delete", { key: "agent:main:own" }],
    ["sessions.delete", { key: "agent:main:own", archivedOnly: true }],
    ["agent", { message: "/reset" }],
    ["tools.invoke", {}],
    ["plugins.sessionAction", { pluginId: "custom", actionId: "protected" }],
  ] as const)("does not turn the session grant into broader authority for %s", (method, params) => {
    admission(method, ["operator.sessions.write"], params).toMatchObject({ allowed: false });
    projection({
      method,
      requestParams: params,
      requestedScopes: ["operator.write", "operator.admin", "operator.questions"],
      allowedScopes: ["operator.sessions.write"],
    }).toEqual([]);
    if (method === "sessions.delete" && "archivedOnly" in params) {
      allow(method, ["operator.write"], params);
    }
  });

  it("preserves a dispatch registry's stronger scope and does not borrow broad read for a write", () => {
    for (const requiredScope of [
      "operator.admin",
      "operator.approvals",
      "operator.questions",
    ] as const) {
      projection({
        method: "sessions.patch",
        requestParams: { label: "updated" },
        requestedScopes: ["operator.write"],
        allowedScopes: ["operator.sessions.write"],
        requiredScope,
      }).toEqual([]);
    }
    for (const scope of ["operator.read", "operator.approvals"] as const) {
      scopeAdmission(scope, [scope, "operator.sessions.write"]).toEqual({ allowed: true });
    }
    scopeAdmission(
      "operator.admin",
      ["operator.sessions.write"],
      resolveSessionMethodScope("sessions.patch", { label: "updated" }),
    ).toEqual({ allowed: false, missingScope: "operator.admin" });
    scopeAdmission(
      "operator.write",
      ["operator.sessions.read"],
      resolveSessionMethodScope("sessions.list"),
    ).toEqual({ allowed: false, missingScope: "operator.write" });
    deny("operator.write", "sessions.patch", ["operator.read"], { label: "updated" });
  });
});
