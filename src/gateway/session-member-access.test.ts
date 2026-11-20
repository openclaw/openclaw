import { expect, it } from "vitest";
import type { SessionVisibility } from "../../packages/gateway-protocol/src/schema/sessions-sharing.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { sourceRolePolicy } from "./operator-role-source-policy.js";
import { sessionSuggestionAddPermissionError } from "./server-methods/sessions-suggestions-access.js";
import { resolveSessionMemberAccess } from "./session-member-access.js";
import {
  authorizeSessionSharingTarget,
  prepareSessionSharingRole,
} from "./session-sharing-policy.js";
import { createProfileSessionEntryFilter } from "./session-sharing-read.js";
import { sharingPolicyClient, sharingPolicyTarget } from "./session-sharing.test-utils.js";

it("matches current role, mutation, suggestion, visibility, and permission-level decisions without a ceiling", () => {
  let compared = 0;
  for (const others of ["none", "invited", "view", "suggest", "write"] as const) {
    for (const visibility of ["shared", "read-only", "suggest", "draft"] as const) {
      for (const present of [false, true]) {
        for (const scope of [
          "operator.sessions.read",
          "operator.sessions.write",
          "operator.write",
        ]) {
          for (const creator of [false, true]) {
            for (const admin of [false, true]) {
              const scopes = admin ? [scope, "operator.admin"] : [scope];
              const client = sharingPolicyClient({ user: "reader", scopes });
              const target = sharingPolicyTarget({
                type: "human",
                id: creator ? "reader" : "author",
              });
              target.entry.visibility = visibility;
              const cap = { value: others };
              const role = prepareSessionSharingRole(
                { client },
                cap,
                () => creator,
              )(target, present);
              const canMutate = !authorizeSessionSharingTarget(
                { client, target },
                { ...cap, role },
              );
              const canSuggest = !sessionSuggestionAddPermissionError(role, others, visibility);
              const canRead =
                admin ||
                createProfileSessionEntryFilter(
                  { profileId: "reader", sessionCap: others },
                  () => creator,
                )(target.canonicalKey, target.entry, present);
              const send = authorizeOperatorScopesForMethod("chat.send", scopes);
              const canStart = send.allowed && (!send.sessionScope || creator);
              const level =
                canStart && canMutate
                  ? "send"
                  : authorizeOperatorScopesForMethod("session.suggestions.add", scopes).allowed &&
                      canSuggest
                    ? "suggest"
                    : "read";
              const actual = resolveSessionMemberAccess({
                policy: { sessions: { others }, scopes: [] },
                scopes,
                creator,
                admin,
                member: { present },
                visibility,
              });
              expect(
                actual,
                JSON.stringify({ others, visibility, present, scope, creator, admin }),
              ).toMatchObject({ role, canRead, canMutate, canSuggest, level });
              compared++;
            }
          }
        }
      }
    }
  }
  expect(compared).toBe(480);
});

it("clamps only opted-in invited grants, defaults NULL to read, and keeps private sessions hidden", () => {
  for (const ceiling of ["read", "suggest", "send"] as const) {
    for (const stored of [undefined, "read", "suggest", "send"] as const) {
      for (const visibility of [
        "shared",
        "read-only",
        "suggest",
        "draft",
      ] satisfies SessionVisibility[]) {
        const levels = ["read", "suggest", "send"];
        const expected =
          levels[Math.min(levels.indexOf(stored ?? "read"), levels.indexOf(ceiling))];
        const facts = {
          policy: {
            sessions: { others: "invited" as const, maxInvitedAccess: ceiling },
            scopes: [],
          },
          scopes: ["operator.sessions.read"],
          creator: false,
          admin: false,
          member: { present: true, access: stored },
          visibility,
        };
        expect(resolveSessionMemberAccess(facts).access).toBe(
          visibility === "draft" ? "none" : expected,
        );
        expect(resolveSessionMemberAccess({ ...facts, member: { present: false } }).access).toBe(
          "none",
        );
        expect(resolveSessionMemberAccess({ ...facts, incognito: true }).access).toBe("none");
        expect(resolveSessionMemberAccess({ ...facts, creator: true }).access).toBe("owner");
        expect(resolveSessionMemberAccess({ ...facts, admin: true }).access).toBe("admin");
      }
    }
  }
});

it("retains the invitation ceiling in captured role policy", () => {
  expect(
    sourceRolePolicy({
      sessions: { others: "invited", maxInvitedAccess: "suggest" },
      scopes: ["operator.sessions.read"],
      agents: ["main"],
    })?.sessions,
  ).toEqual({ others: "invited", maxInvitedAccess: "suggest" });
});
