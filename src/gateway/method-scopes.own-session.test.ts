import { describe, expect, it } from "vitest";
import { resolveSessionMethodScope } from "../shared/session-method-scopes-base.js";
import {
  authorizeOperatorScopesForMethod,
  authorizeOperatorScopesForRequiredScope,
  projectOperatorScopesForMethod,
} from "./method-scopes.js";

describe("session-scoped method admission", () => {
  it("keeps agent catalogs behind broad read authority", () => {
    expect(resolveSessionMethodScope("agents.list", {})).toBeUndefined();
    for (const scopes of [
      ["operator.sessions.read"],
      ["operator.sessions.write"],
      ["operator.sessions.read", "operator.sessions.write"],
    ]) {
      expect(authorizeOperatorScopesForMethod("agents.list", scopes, {})).toEqual({
        allowed: false,
        missingScope: "operator.read",
      });
    }
    for (const scope of ["operator.read", "operator.write", "operator.admin"]) {
      expect(
        authorizeOperatorScopesForMethod("agents.list", [scope, "operator.sessions.read"], {}),
      ).toEqual({ allowed: true });
    }
  });

  it.each([
    {},
    { agentId: "main" },
    { sessionKey: "agent:main:own" },
    { sessionKey: "agent:main:own", view: "provider-config" },
    { agentId: "main", authProfileId: "personal-account" },
  ])("admits projected model catalogs with the registered session-read floor (%j)", (params) => {
    expect(resolveSessionMethodScope("models.list", params)).toBeUndefined();
    expect(authorizeOperatorScopesForMethod("models.list", [], params)).toEqual({
      allowed: false,
      missingScope: "operator.sessions.read",
    });
    for (const scope of [
      "operator.sessions.read",
      "operator.sessions.write",
      "operator.read",
      "operator.write",
      "operator.admin",
    ]) {
      expect(authorizeOperatorScopesForMethod("models.list", [scope], params)).toEqual({
        allowed: true,
      });
    }
  });

  it.each(["sessions.list", "chat.history", "sessions.describe", "session.members.list"])(
    "admits %s for a session reader without granting a global read scope",
    (method) => {
      expect(authorizeOperatorScopesForMethod(method, ["operator.sessions.read"])).toEqual({
        allowed: true,
        sessionScope: "operator.sessions.read",
      });
      expect(
        authorizeOperatorScopesForMethod("config.get", ["operator.sessions.read"]),
      ).toMatchObject({ allowed: false });
      for (const allowed of ["operator.sessions.read", "operator.sessions.write"]) {
        expect(
          projectOperatorScopesForMethod({
            method,
            requestParams: {},
            requestedScopes: ["operator.read", "operator.admin"],
            allowedScopes: [allowed],
          }),
        ).toEqual(["operator.sessions.read"]);
      }
    },
  );

  it.each([
    ["chat.send", { sessionKey: "agent:main:own", message: "hello" }],
    ["sessions.create", {}],
    ["sessions.patch", { key: "agent:main:own", label: "updated" }],
    ["sessions.patchMany", { targets: [{ key: "agent:main:own" }], patch: { unread: true } }],
    ["sessions.delete", { key: "agent:main:own", archivedOnly: true }],
  ] as const)("requires the narrow write grant for %s", (method, params) => {
    expect(authorizeOperatorScopesForMethod(method, ["operator.sessions.write"], params)).toEqual({
      allowed: true,
      sessionScope: "operator.sessions.write",
    });
    expect(
      authorizeOperatorScopesForMethod(method, ["operator.sessions.read"], params),
    ).toMatchObject({ allowed: false });
    expect(authorizeOperatorScopesForMethod(method, ["operator.write"], params)).toEqual({
      allowed: true,
    });
    expect(
      projectOperatorScopesForMethod({
        method,
        requestParams: params,
        requestedScopes: ["operator.write", "operator.approvals"],
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
  });

  it.each([
    "question.request",
    "question.get",
    "question.list",
    "question.waitAnswer",
    "question.resolve",
  ])(
    "admits %s through the own-run question boundary without granting broader authority",
    (method) => {
      expect(authorizeOperatorScopesForMethod(method, ["operator.sessions.write"])).toEqual({
        allowed: true,
        sessionScope: "operator.sessions.write",
      });
      expect(authorizeOperatorScopesForMethod(method, ["operator.sessions.read"])).toEqual({
        allowed: false,
        missingScope: "operator.questions",
      });
      expect(authorizeOperatorScopesForMethod(method, ["operator.questions"])).toEqual({
        allowed: true,
      });
      expect(
        projectOperatorScopesForMethod({
          method,
          requestParams: {},
          requestedScopes: ["operator.questions", "operator.approvals", "operator.admin"],
          allowedScopes: ["operator.sessions.write"],
        }),
      ).toEqual(["operator.sessions.write"]);
    },
  );

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
