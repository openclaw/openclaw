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
      expectScope("operator.write", method);
      deny("operator.write", method, ["operator.read"]);
      allow(method, ["operator.write"]);
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
    expectScope("operator.read", "talk.config", {});
    required("talk.config", { includeSecrets: true }).toEqual([
      "operator.read",
      "operator.talk.secrets",
    ]);
    deny("operator.talk.secrets", "talk.config", ["operator.read"], {
      includeSecrets: true,
    });
    allow("talk.config", ["operator.read", "operator.talk.secrets"], {
      includeSecrets: true,
    });
  });

  it("accepts dedicated Talk access and preserves operator.write compatibility", () => {
    allow("talk.client.create", ["operator.talk"]);
    allow("talk.client.create", ["operator.write"]);
    deny("operator.talk", "talk.client.create", ["operator.read"]);
  });

  it("requires admin only when DM pairing approval bootstraps a command owner", () => {
    expectScope("operator.pairing", "channels.pairing.approve", {});
    required("channels.pairing.approve", {
      bootstrapCommandOwner: true,
    }).toEqual(["operator.pairing", "operator.admin"]);
    deny("operator.admin", "channels.pairing.approve", ["operator.pairing"], {
      bootstrapCommandOwner: true,
    });
    allow("channels.pairing.approve", ["operator.pairing", "operator.admin"], {
      bootstrapCommandOwner: true,
    });
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

    expectScope("operator.approvals", "plugins.sessionAction", {
      pluginId: "scope-plugin",
      actionId: "approve",
    });
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
    allow("plugins.sessionAction", ["operator.approvals"], {
      pluginId: "scope-plugin",
      actionId: "approve",
    });
    deny("operator.approvals", "plugins.sessionAction", ["operator.write"], {
      pluginId: "scope-plugin",
      actionId: "approve",
    });
  });

  it("defers Gateway cwd containment to sessions.create while keeping node cwd admin-only", () => {
    expectScope("operator.write", "sessions.create", { worktree: true });
    expectScope("operator.write", "sessions.create", { cwd: "/other/repo" });
    allow("sessions.create", ["operator.write"], {
      cwd: "/other/repo",
    });
    expectScope("operator.write", "sessions.create", {
      worktree: true,
      cwd: "/other/repo",
    });
    allow("sessions.create", ["operator.write"], {
      worktree: true,
      cwd: "/other/repo",
    });
    expectScope("operator.admin", "sessions.create", {
      execNode: "macbook",
      cwd: "/other/repo",
    });
  });

  it("requires operator.write rather than own-session scope for device folders", () => {
    const params = { deviceFolder: { deviceId: "paired-device", path: "~/project" } };
    expectScope("operator.write", "sessions.create", params);
    allow("sessions.create", ["operator.write"], params);
    deny("operator.write", "sessions.create", ["operator.sessions.write"], params);
  });

  it("keeps Gateway fs.listDir write-scoped and node browsing admin-only", () => {
    expectScope("operator.write", "fs.listDir", {});
    allow("fs.listDir", ["operator.write"], {
      path: "/configured/workspace",
    });
    expectScope("operator.admin", "fs.listDir", { nodeId: "macbook" });
    deny("operator.admin", "fs.listDir", ["operator.write"], {
      nodeId: "macbook",
    });
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
      required(method, params).toEqual([scope]);
      allow(method, [scope], params);
      if (scope === "operator.admin") {
        deny("operator.admin", method, ["operator.write"], params);
      }
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
      expectScope("operator.admin", "sessions.create", params);
      deny("operator.admin", "sessions.create", ["operator.write"], params);
      allow("sessions.create", ["operator.admin"], params);
    }
    expectScope("operator.write", "sessions.create", { incognito: false });
  });

  it("grants write-scope sessions.delete only with the archivedOnly opt-in", () => {
    // Internal callers (subagent cleanup, fallback synthetic dispatch, CLI
    // minting) never set archivedOnly and keep requiring admin; the handler
    // enforces that archivedOnly targets are actually archived.
    expectScope("operator.admin", "sessions.delete");
    expectScope("operator.admin", "sessions.delete", {
      key: "agent:main:old",
      deleteTranscript: true,
    });
    expectScope("operator.write", "sessions.delete", {
      key: "agent:main:old",
      archivedOnly: true,
    });
    const archivedParams = { key: "agent:main:old", archivedOnly: true };
    allow("sessions.delete", ["operator.write"], archivedParams);
    deny("operator.write", "sessions.delete", ["operator.read"], archivedParams);
    deny("operator.admin", "sessions.delete", ["operator.write"], {
      key: "agent:main:old",
    });
    deny("operator.admin", "sessions.delete", ["operator.write"], {
      key: "agent:main:old",
      archivedOnly: "yes",
    });
    // Internal-only controls must not ride along on the write-scope path.
    deny("operator.admin", "sessions.delete", ["operator.write"], {
      key: "agent:main:old",
      archivedOnly: true,
      emitLifecycleHooks: false,
    });
    allow("sessions.delete", ["operator.write"], {
      key: "agent:main:old",
      archivedOnly: true,
      expectedSessionId: "sess-1",
    });
    expectScope("operator.write", "sessions.delete", {
      key: "agent:main:old",
      archivedOnly: true,
      expectedSessionId: "sess-1",
    });
    deny("operator.admin", "sessions.delete", ["operator.write"], {
      key: "agent:main:old",
      archivedOnly: true,
      expectedSessionId: "sess-1",
      futureField: true,
    });
    expectScope("operator.admin", "sessions.delete", {
      key: "agent:main:old",
      archivedOnly: true,
      emitLifecycleHooks: false,
    });
    allow("sessions.delete", ["operator.admin"]);
  });

  it("requires admin for browser.request", () => {
    setPluginGatewayMethodScope("browser.request", "operator.admin");

    expectScope("operator.admin", "browser.request");
    deny("operator.admin", "browser.request", ["operator.write"]);
    allow("browser.request", ["operator.admin"]);
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
    for (const method of [
      "skills.proposals.list",
      "skills.proposals.events.list",
      "skills.proposals.inspect",
      "skills.proposals.historyStatus",
    ]) {
      expect(listGatewayMethods()).toContain(method);
      expect(coreGatewayHandlers).toHaveProperty(method);
      expectScope("operator.read", method);
      allow(method, ["operator.read"]);
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
      expectScope("operator.admin", method);
      deny("operator.admin", method, ["operator.write"]);
      allow(method, ["operator.admin"]);
    }
  });

  it("keeps permission CAS write-scoped while full remains admin-only", () => {
    const guarded = {
      key: "agent:main:ios-1",
      expectedPermissionMode: "read-only",
      permissionMode: "guarded",
    };
    expectScope("operator.write", "sessions.patch", guarded);
    allow("sessions.patch", ["operator.write"], guarded);
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
