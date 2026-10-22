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
  it("admits own PR preparation while retaining full-write admission for privileged actions", () => {
    for (const action of [
      "inspect_pr",
      "prepare_pr",
      "refresh_base",
      "edit",
      "request_review",
      "ready",
      "upload_evidence",
    ]) {
      allow("sessions.github.action", ["operator.sessions.write"], { action });
    }
    deny("operator.write", "sessions.github.action", ["operator.sessions.write"], {
      action: "ready",
      publishingSessionKey: "agent:main:child",
    });
    for (const action of ["inspect", "merge", "close", "unknown"]) {
      deny("operator.write", "sessions.github.action", ["operator.sessions.write"], {
        action,
      });
    }
  });
  const incognitoKey = "agent:main:dashboard:incognito-parent";
  const guarded = {
    key: "agent:main:ios-1",
    expectedPermissionMode: "read-only",
    permissionMode: "guarded",
  };
  const move = (target: { kind: "gateway" } | { kind: "profile"; profileId: string }) => ({
    key: "agent:main:thread",
    expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
    target,
  });
  it.each([
    ["users.background.get", undefined, "operator.read"],
    ["users.background.upload", undefined, "operator.write", "operator.read"],
    ["users.background.remove", undefined, "operator.write", "operator.read"],
    ["environments.list", { runtimeId: "openclaw" }, "operator.write", "operator.read"],
    ["agent", { message: "hello" }, "operator.write"],
    ["agent", { message: "/reset" }, "operator.admin", "operator.write"],
    ["agent", { message: "/new follow up" }, "operator.admin"],
    ["node.invoke", { command: "device.info" }, "operator.write"],
    ["node.invoke", { command: "browser.proxy" }, "operator.admin"],
    ["node.invoke", { command: "browser.proxy.upload.v1" }, "operator.admin"],
    ["node.invoke", { command: "fs.listDir" }, "operator.admin", "operator.write"],
    [
      "node.invoke",
      { command: "browser.proxy.upload.v1", params: { method: "POST", path: "/profiles/create" } },
      "operator.write",
    ],
    ["sessions.create", { worktree: true }, "operator.write"],
    ["sessions.create", { cwd: "/other/repo" }, "operator.write"],
    ["sessions.create", { worktree: true, cwd: "/other/repo" }, "operator.write"],
    ["sessions.create", { execNode: "macbook", cwd: "/other/repo" }, "operator.admin"],
    [
      "sessions.create",
      { deviceFolder: { deviceId: "paired-device", path: "~/project" } },
      "operator.write",
      "operator.sessions.write",
    ],
    ["sessions.create", { agentId: "main", incognito: true }, "operator.admin", "operator.write"],
    ["sessions.create", { key: incognitoKey }, "operator.admin", "operator.write"],
    ["sessions.create", { parentSessionKey: incognitoKey }, "operator.admin", "operator.write"],
    [
      "sessions.create",
      { agentId: "main", toolOverrides: { skills: { release: false } } },
      "operator.admin",
      "operator.write",
    ],
    ["sessions.create", { incognito: false }, "operator.write"],
    ["fs.listDir", {}, "operator.write"],
    ["fs.listDir", { path: "/configured/workspace" }, "operator.write"],
    ["fs.listDir", { nodeId: "macbook" }, "operator.admin", "operator.write"],
    ["node.pair.approve", undefined, "operator.pairing", "operator.write"],
    ["approval.resolve", undefined, "operator.approvals", "operator.write"],
    ["sessions.patch", guarded, "operator.write"],
    ["sessions.patch", { ...guarded, permissionMode: "full" }, "operator.admin", "operator.write"],
  ] satisfies [string, unknown, string, string?][])(
    "%s (%j) requires %s",
    (method, params, scope, denied?: string) => expectAccess(scope, method, params, denied),
  );

  it("leaves node-only pending drain outside operator scopes", () => {
    expect(isGatewayMethodClassified("node.pending.drain")).toBe(true);
    required("node.pending.drain").toStrictEqual([]);
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
    ["gateway move", "sessions.move", move({ kind: "gateway" }), "operator.write"],
    [
      "profile move",
      "sessions.move",
      move({ kind: "profile", profileId: "development" }),
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
    ["controlUi.sessionPullRequests.subscribe", { sessionKeys: ["agent:main:own"] }, true],
    ["controlUi.sessionPullRequests.checks", { sessionKey: "agent:main:own" }, true],
    [
      "sessions.files.assets",
      { sessionKey: "agent:main:own", path: "index.html", refs: ["a.png"] },
      true,
    ],
    ["config.get", undefined, false],
    ["controlUi.githubDetail", { sessionKey: "agent:main:own" }, false],
    ["controlUi.githubPreview", { sessionKey: "agent:main:own" }, false],
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
