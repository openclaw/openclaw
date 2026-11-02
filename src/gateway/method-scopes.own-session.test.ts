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

const READ = "operator.read";
const WRITE = "operator.write";
const ADMIN = "operator.admin";
const OWN_READ = "operator.sessions.read";
const OWN_WRITE = "operator.sessions.write";
const APPROVALS = "operator.approvals";
const QUESTIONS = "operator.questions";
const PAIRING = "operator.pairing";
const TALK = "operator.talk";
const SECRETS = "operator.talk.secrets";

const required = (...args: Parameters<typeof resolveLeastPrivilegeOperatorScopesForMethod>) =>
  expect(resolveLeastPrivilegeOperatorScopesForMethod(...args));
const admission = (...args: Parameters<typeof authorizeOperatorScopesForMethod>) =>
  expect(authorizeOperatorScopesForMethod(...args));
const scopeAdmission = (...args: Parameters<typeof authorizeOperatorScopesForRequiredScope>) =>
  expect(authorizeOperatorScopesForRequiredScope(...args));
function expectProjection(
  method: string,
  requestParams: unknown,
  requestedScopes: string[],
  allowedScopes: string[],
  expected: string[],
  requiredScope?: Parameters<typeof projectOperatorScopesForMethod>[0]["requiredScope"],
) {
  expect(
    projectOperatorScopesForMethod({
      method,
      requestParams,
      requestedScopes,
      allowedScopes,
      requiredScope,
    }),
  ).toEqual(expected);
}

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
function expectAccess(
  scope: string | string[],
  method: string,
  params?: unknown,
  deniedScope?: string,
) {
  const scopes = typeof scope === "string" ? [scope] : scope;
  required(method, params).toEqual(scopes);
  allow(method, scopes, params);
  if (deniedScope) {
    deny(scopes.at(-1)!, method, [deniedScope], params);
  }
}

const RESERVED_ADMIN_PLUGIN_METHOD = "config.plugin.inspect";
const pluginHandler: GatewayRequestHandler = ({ respond }) => respond(true, {});
const ownKey = { key: "agent:main:own" };
const ownSession = { sessionKey: ownKey.key };

function setPluginGatewayMethodScope(
  method: string,
  scope: typeof READ | typeof WRITE | typeof ADMIN,
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
      allow("sessions.github.action", [OWN_WRITE], { action });
    }
    deny(WRITE, "sessions.github.action", [OWN_WRITE], {
      action: "ready",
      publishingSessionKey: "agent:main:child",
    });
    for (const action of ["inspect", "merge", "close", "unknown"]) {
      deny(WRITE, "sessions.github.action", [OWN_WRITE], { action });
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
    ["users.background.get", undefined, READ],
    ["users.background.upload", undefined, WRITE, READ],
    ["users.background.remove", undefined, WRITE, READ],
    ["environments.list", { runtimeId: "openclaw" }, WRITE, READ],
    ["talk.config", {}, READ],
    ["talk.config", { includeSecrets: true }, [READ, SECRETS], READ],
    ["channels.pairing.approve", {}, PAIRING],
    ["channels.pairing.approve", { bootstrapCommandOwner: true }, [PAIRING, ADMIN], PAIRING],
    ["agent", { message: "hello" }, WRITE],
    ["agent", { message: "/reset" }, ADMIN, WRITE],
    ["agent", { message: "/new follow up" }, ADMIN],
    ["node.invoke", { command: "device.info" }, WRITE],
    ["node.invoke", { command: "browser.proxy" }, ADMIN],
    ["node.invoke", { command: "browser.proxy.upload.v1" }, ADMIN],
    ["node.invoke", { command: "fs.listDir" }, ADMIN, WRITE],
    [
      "node.invoke",
      { command: "browser.proxy.upload.v1", params: { method: "POST", path: "/profiles/create" } },
      WRITE,
    ],
    ["sessions.create", { worktree: true, cwd: "/other/repo" }, WRITE],
    ["sessions.create", { execNode: "macbook", cwd: "/other/repo" }, ADMIN],
    [
      "sessions.create",
      { deviceFolder: { deviceId: "paired-device", path: "~/project" } },
      WRITE,
      OWN_WRITE,
    ],
    ["sessions.create", { agentId: "main", incognito: true }, ADMIN, WRITE],
    ["sessions.create", { key: incognitoKey }, ADMIN, WRITE],
    ["sessions.create", { parentSessionKey: incognitoKey }, ADMIN, WRITE],
    [
      "sessions.create",
      { agentId: "main", toolOverrides: { skills: { release: false } } },
      ADMIN,
      WRITE,
    ],
    ["fs.listDir", {}, WRITE],
    ["fs.listDir", { nodeId: "macbook" }, ADMIN, WRITE],
    ["node.pair.approve", undefined, PAIRING, WRITE],
    ["approval.resolve", undefined, APPROVALS, WRITE],
    ["sessions.patch", guarded, WRITE],
    ["sessions.patch", { ...guarded, permissionMode: "full" }, ADMIN, WRITE],
    ["sessions.dispatch", { ...ownKey, deviceId: "device-1" }, WRITE],
    ["sessions.dispatch", { ...ownKey, profileId: "development" }, WRITE, READ],
    ["sessions.dispatch", ownKey, ADMIN, WRITE],
    ["sessions.move", move({ kind: "gateway" }), WRITE],
    ["sessions.move", move({ kind: "profile", profileId: "development" }), ADMIN, WRITE],
  ] satisfies [string, unknown, string | string[], string?][])(
    "%s (%j) requires %s",
    (method, params, scope, denied?: string) => expectAccess(scope, method, params, denied),
  );

  it("leaves node-only pending drain outside operator scopes", () => {
    expect(isGatewayMethodClassified("node.pending.drain")).toBe(true);
    required("node.pending.drain").toStrictEqual([]);
  });

  it("accepts dedicated Talk access and preserves operator.write compatibility", () => {
    allow("talk.client.create", [TALK]);
    allow("talk.client.create", [WRITE]);
    deny(TALK, "talk.client.create", [READ]);
  });

  it("classifies plugin session actions with a CLI-safe default operator scope", () => {
    expectScope(WRITE, "plugins.sessionAction");
    expect(isGatewayMethodClassified("plugins.sessionAction")).toBe(true);
    deny(WRITE, "plugins.sessionAction", [READ]);
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
      makeAction("approve", [APPROVALS]),
      makeAction("view", [READ]),
      makeAction("default-write"),
    ].map((action) => ({
      pluginId: "scope-plugin",
      pluginName: "Scope Plugin",
      source: "test",
      action,
    }));
    setActivePluginRegistry(registry);

    const actionParams = (actionId: string, pluginId = "scope-plugin") => ({ pluginId, actionId });
    expectAccess(APPROVALS, "plugins.sessionAction", actionParams("approve"), WRITE);
    expectScope(READ, "plugins.sessionAction", actionParams(" view ", " scope-plugin "));
    expectScope(WRITE, "plugins.sessionAction", actionParams("default-write"));
    required("plugins.sessionAction", actionParams("missing")).toEqual(
      createExpectedBroadOperatorScopes(),
    );
  });

  it("grants write-scope sessions.delete only with the archivedOnly opt-in", () => {
    expectScope(ADMIN, "sessions.delete");
    expectScope(ADMIN, "sessions.delete", {
      key: "agent:main:old",
      deleteTranscript: true,
    });
    const archivedParams = { key: "agent:main:old", archivedOnly: true };
    expectAccess(WRITE, "sessions.delete", archivedParams, READ);
    for (const params of [
      { key: archivedParams.key },
      { ...archivedParams, archivedOnly: "yes" },
      { ...archivedParams, emitLifecycleHooks: false },
      { ...archivedParams, expectedSessionId: "sess-1", futureField: true },
    ]) {
      deny(ADMIN, "sessions.delete", [WRITE], params);
    }
    expectAccess(WRITE, "sessions.delete", {
      ...archivedParams,
      expectedSessionId: "sess-1",
    });
    expectScope(ADMIN, "sessions.delete", {
      ...archivedParams,
      emitLifecycleHooks: false,
    });
    allow("sessions.delete", [ADMIN]);
  });

  it("requires admin for browser.request", () => {
    setPluginGatewayMethodScope("browser.request", ADMIN);

    expectAccess(ADMIN, "browser.request", undefined, WRITE);
  });

  it("keeps broad question authority distinct from own-run admission", () => {
    admission("question.resolve", [WRITE]).toEqual({ allowed: true, sessionScope: OWN_WRITE });
    allow("question.resolve", [QUESTIONS]);
  });

  it("requires admin for unknown methods", () => {
    required("unknown.method").toStrictEqual([]);
    deny(ADMIN, "unknown.method", [READ]);
  });

  it("requires admin for reserved admin namespaces even if a plugin registered a narrower scope", () => {
    setPluginGatewayMethodScope(RESERVED_ADMIN_PLUGIN_METHOD, READ);

    expectScope(ADMIN, RESERVED_ADMIN_PLUGIN_METHOD);
    deny(ADMIN, RESERVED_ADMIN_PLUGIN_METHOD, [READ]);
  });

  it("exposes skill proposal methods through the core gateway registry", () => {
    for (const [scope, names] of [
      [READ, ["list", "events.list", "inspect", "historyStatus"]],
      [
        ADMIN,
        ["create", "update", "revise", "evaluate", "historyScan", "apply", "reject", "quarantine"],
      ],
    ] as const) {
      for (const name of names) {
        const method = `skills.proposals.${name}`;
        expect(listGatewayMethods()).toContain(method);
        expect(coreGatewayHandlers).toHaveProperty(method);
        expectAccess(scope, method, undefined, scope === ADMIN ? WRITE : undefined);
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
      { allowed: false, missingScope: ADMIN },
    ],
  ] as const)(
    "checks requester delivery method %s against the real plugin client grant",
    (method, params, expected) => {
      const client = createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "voice-call" });
      admission(method, client.connect.scopes ?? [], params).toEqual(expected);
    },
  );

  it.each([
    ["sessions.diff", ownSession, true],
    ["controlUi.sessionPullRequests.subscribe", { sessionKeys: [ownKey.key] }, true],
    ["controlUi.sessionPullRequests.checks", ownSession, true],
    ["sessions.files.assets", { ...ownSession, path: "index.html", refs: ["a.png"] }, true],
    ["config.get", undefined, false],
    ["controlUi.githubDetail", ownSession, false],
    ["controlUi.githubPreview", ownSession, false],
  ] as const)(
    "restricts the narrow read alternative to session and bootstrap methods: %s",
    (method, params, narrow) => {
      for (const scopes of [[OWN_READ], [OWN_WRITE], [OWN_READ, OWN_WRITE]]) {
        admission(method, scopes, params).toEqual(
          narrow
            ? { allowed: true, sessionScope: OWN_READ }
            : { allowed: false, missingScope: READ },
        );
      }
      if (!narrow) {
        return;
      }
      for (const scope of [READ, WRITE, ADMIN]) {
        allow(method, [scope, OWN_READ], params);
      }
      for (const allowed of [OWN_READ, OWN_WRITE]) {
        expectProjection(method, params, [READ, ADMIN], [allowed], [OWN_READ]);
      }
    },
  );

  it.each([
    ["chat.send", { ...ownSession, message: "hello" }, WRITE],
    ["question.resolve", {}, QUESTIONS],
  ] as const)("requires the narrow write grant for %s", (method, params, broad) => {
    admission(method, [OWN_WRITE], params).toEqual({ allowed: true, sessionScope: OWN_WRITE });
    admission(method, [OWN_READ], params).toEqual({ allowed: false, missingScope: broad });
    allow(method, [broad], params);
    expectProjection(
      method,
      params,
      [broad, APPROVALS, ...(broad === QUESTIONS ? [ADMIN] : [])],
      [OWN_WRITE],
      [OWN_WRITE],
    );
  });

  it.each([
    ["sessions.create", { incognito: true }],
    ["sessions.patch", { ...ownKey, permissionMode: "full" }],
    ["sessions.patchMany", { targets: [ownKey], patch: { sandboxMode: "off" } }],
    ["sessions.patch", { ...ownKey, unknownMutation: true }],
    ["sessions.delete", ownKey],
    ["sessions.delete", { ...ownKey, archivedOnly: true }],
    ["agent", { message: "/reset" }],
    ["tools.invoke", {}],
    ["plugins.sessionAction", { pluginId: "custom", actionId: "protected" }],
  ] as const)("does not turn the session grant into broader authority for %s", (method, params) => {
    admission(method, [OWN_WRITE], params).toMatchObject({ allowed: false });
    expectProjection(method, params, [WRITE, ADMIN, QUESTIONS], [OWN_WRITE], []);
    if (method === "sessions.delete" && "archivedOnly" in params) {
      allow(method, [WRITE], params);
    }
  });

  it("preserves a dispatch registry's stronger scope and does not borrow broad read for a write", () => {
    for (const requiredScope of [ADMIN, APPROVALS, QUESTIONS] as const) {
      expectProjection(
        "sessions.patch",
        { label: "updated" },
        [WRITE],
        [OWN_WRITE],
        [],
        requiredScope,
      );
    }
    for (const scope of [READ, APPROVALS] as const) {
      scopeAdmission(scope, [scope, OWN_WRITE]).toEqual({ allowed: true });
    }
    scopeAdmission(
      ADMIN,
      [OWN_WRITE],
      resolveSessionMethodScope("sessions.patch", { label: "updated" }),
    ).toEqual({ allowed: false, missingScope: ADMIN });
    scopeAdmission(WRITE, [OWN_READ], resolveSessionMethodScope("sessions.list")).toEqual({
      allowed: false,
      missingScope: WRITE,
    });
    deny(WRITE, "sessions.patch", [READ], { label: "updated" });
  });
});
