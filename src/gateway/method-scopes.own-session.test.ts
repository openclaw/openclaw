import { describe, expect, it } from "vitest";
import { resolveSessionMethodScope } from "../shared/session-method-scopes-base.js";
import {
  authorizeOperatorScopesForMethod,
  authorizeOperatorScopesForRequiredScope,
  projectOperatorScopesForMethod,
} from "./method-scopes.js";

describe("session-scoped method admission", () => {
  it.each([
    ["agent.identity.get", { agentId: "main" }, true],
    ["agents.list", {}, true],
    ["canvas.document.preview", { html: "<p>Preview</p>" }, true],
    ["models.list", {}, true],
    ["models.list", { sessionKey: "agent:main:own" }, true],
    ["progressCard.get", { sessionKey: "agent:main:own" }, true],
    ["projects.list", {}, true],
    ["session.suggestions.list", { sessionKey: "agent:main:own" }, true],
    ["session.reactions.list", { sessionKey: "agent:main:own" }, true],
    ["sessions.groups.list", {}, true],
    ["sessions.list", {}, true],
    ["chat.history", { sessionKey: "agent:main:own" }, true],
    ["chat.startup", { sessionKey: "agent:main:own" }, true],
    ["chat.metadata", { sessionKey: "agent:main:own" }, true],
    ["sessions.describe", { key: "agent:main:own" }, true],
    [
      "sessions.files.assets",
      { sessionKey: "agent:main:own", path: "index.html", refs: ["a.png"] },
      true,
    ],
    ["session.members.list", { sessionKey: "agent:main:own" }, true],
    ["themes.get", { id: "default" }, true],
    ["themes.list", {}, true],
    ["users.prefs.get", {}, true],
    ["users.self", {}, true],
    ["config.get", undefined, false],
    ["canvas.document.view", undefined, false],
    ["artifacts.list", undefined, false],
    ["artifacts.get", undefined, false],
    ["artifacts.download", undefined, false],
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
    ["question.request", {}, "operator.questions"],
    ["question.get", {}, "operator.questions"],
    ["question.list", {}, "operator.questions"],
    ["question.waitAnswer", {}, "operator.questions"],
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
    ["users.setDisplayName", {}],
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

  it.each([
    { requestedScopes: [] },
    { requestedScopes: ["operator.admin"] },
    { requestedScopes: ["operator.approvals"] },
    { requestedScopes: ["operator.read"] },
  ])(
    "does not derive a session write from unrelated requested scopes $requestedScopes",
    ({ requestedScopes }) => {
      expect(
        projectOperatorScopesForMethod({
          method: "sessions.create",
          requestParams: {},
          requestedScopes,
          allowedScopes: ["operator.sessions.write"],
        }),
      ).toEqual([]);
    },
  );
});
