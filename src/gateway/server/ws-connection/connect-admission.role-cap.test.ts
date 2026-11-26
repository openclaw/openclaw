import { expect, it } from "vitest";
import { capConnectionScopesByRole } from "./connect-admission.js";

it("records role-capped scopes even when the cap keeps the list length", () => {
  // operator.admin implies operator.sessions.read, so the capped list is just as long.
  expect(
    capConnectionScopesByRole(["operator.admin"], { scopes: ["operator.sessions.read"] }),
  ).toEqual({ scopes: ["operator.sessions.read"], roleCappedScopes: ["operator.admin"] });
  expect(
    capConnectionScopesByRole(["operator.sessions.read"], { scopes: ["operator.admin"] }),
  ).toEqual({ scopes: ["operator.sessions.read"] });
});
