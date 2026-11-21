import { expect, it } from "vitest";
import type { SessionVisibility } from "../../packages/gateway-protocol/src/schema/sessions-sharing.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { sourceRolePolicy } from "./operator-role-source-policy.js";
import { sessionSuggestionAddPermissionError } from "./server-methods/sessions-suggestions-access.js";
import { resolveSessionMemberAccess } from "./session-member-access.js";
import {
  authorizeSessionSharingTarget,
  prepareSessionSharingRole,
} from "./session-sharing-policy.js";
import { createProfileSessionEntryFilter, prepareSessionSharing } from "./session-sharing-read.js";
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
              const canMutate =
                !(others === "none" && !creator && !admin) &&
                (visibility === "draft"
                  ? creator || admin
                  : role !== "viewer" ||
                    (visibility === "shared" && !["invited", "view", "suggest"].includes(others)));
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
              const canReact =
                others !== "none" &&
                !(others === "view" && role === "viewer") &&
                (canMutate || (visibility === "suggest" && others !== "view"));
              const canType =
                !(role === "viewer" && others === "view") &&
                (visibility !== "draft" || role === "owner" || role === "admin") &&
                (role !== "viewer" || visibility === "shared" || visibility === "suggest");
              const prepared = prepareSessionSharing(
                { client },
                {
                  aliases: new Set(["reader"]),
                  sessionCap: others,
                  policy: { sessions: { others }, scopes: [], agents: "*" },
                  isMember: () => present,
                },
              );
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
              ).toMatchObject({ role, canRead, canMutate, canSuggest, canReact, canType, level });
              expect(prepared.accessForTarget(target)).toMatchObject({
                role,
                canRead,
                canMutate,
                canSuggest,
                canReact,
                canType,
                level,
              });
              expect(!prepared.authorizeTarget(target)).toBe(canMutate);
              expect(!authorizeSessionSharingTarget({ client, target }, { ...cap, role })).toBe(
                canMutate,
              );
              expect(
                !sessionSuggestionAddPermissionError(
                  role,
                  others,
                  visibility,
                  prepared.accessForTarget(target),
                ),
              ).toBe(canSuggest);
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

it("uses stored invited levels for collaboration without granting management", () => {
  const client = sharingPolicyClient({
    user: "guest",
    scopes: ["operator.write", "operator.read"],
  });
  const target = sharingPolicyTarget({ type: "human", id: "owner" });
  for (const visibility of ["shared", "read-only", "suggest", "draft"] as const) {
    target.entry.visibility = visibility;
    for (const level of [undefined, "read", "suggest", "send"] as const) {
      const policy: GatewayOperatorRoleDefinition = {
        sessions: { others: "invited" as const, maxInvitedAccess: "send" as const },
        scopes: ["operator.read"],
        agents: "*" as const,
      };
      const sharing = prepareSessionSharing(
        { client },
        {
          policy,
          aliases: new Set(["guest"]),
          sessionCap: "invited",
          isMember: () => true,
          memberAccess: () => level,
        },
      );
      const access = sharing.accessForTarget(target);
      const visible = visibility !== "draft";
      expect(access.canMutate).toBe(visible && level === "send");
      expect(access.canSuggest).toBe(visible && (level === "suggest" || level === "send"));
      expect(access.canReact).toBe(access.canSuggest);
      expect(access.canType).toBe(access.canSuggest);
      expect(!sessionSuggestionAddPermissionError("member", "invited", visibility, access)).toBe(
        access.canSuggest,
      );
      expect(sharing.authorizeTarget(target, undefined, false)).not.toBeNull();
      expect(!sharing.authorizeTarget(target, undefined, true)).toBe(access.canMutate);
    }
  }
});
