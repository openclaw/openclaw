import { describe, expect, it } from "vitest";
import { verifyPriorCiWriterAuthority } from "../../scripts/pr-lib/merge-prior-ci.mjs";

const rule = {
  type: "required_status_checks",
  ruleset_id: 41,
  ruleset_source: "fixture/repo",
  ruleset_source_type: "Repository",
  parameters: {
    strict_required_status_checks_policy: false,
    do_not_enforce_on_create: false,
    required_status_checks: [{ context: "openclaw/ci-gate", integration_id: 15368 }],
  },
};

function fixture(
  options: {
    changeKind?: string;
    authority?: Record<string, unknown>;
    membership?: Record<string, unknown>;
    ruleset?: Record<string, unknown>;
    rules?: Array<Record<string, unknown>>;
    unavailable?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const writerRead = (endpoint: string) => {
    calls.push(endpoint);
    if (endpoint === "repos/fixture/repo") {
      return {
        id: 123,
        full_name: "fixture/repo",
        owner: { type: "Organization", login: "fixture" },
        permissions: { admin: false, maintain: true, push: true },
        ...options.authority,
      };
    }
    if (endpoint === "orgs/fixture/memberships/fixture-bot") {
      return {
        state: "active",
        role: "member",
        user: { login: "fixture-bot" },
        ...options.membership,
      };
    }
    if (endpoint === "repos/fixture/repo/rulesets/41") {
      if (options.unavailable) {
        throw new Error("GitHub authority unavailable");
      }
      return {
        id: 41,
        source: "fixture/repo",
        source_type: "Repository",
        target: "branch",
        enforcement: "active",
        current_user_can_bypass: "always",
        rules: [{ type: rule.type, parameters: rule.parameters }],
        ...options.ruleset,
      };
    }
    throw new Error("Unexpected writer request: " + endpoint);
  };
  return {
    calls,
    verify: () =>
      verifyPriorCiWriterAuthority({
        repository: "fixture/repo",
        actor: "fixture-bot",
        changeKind: options.changeKind ?? "pre-existing-failure",
        policy: { rules: options.rules ?? [rule] },
        writerRead,
      }),
  };
}

describe("prior-CI delegated writer authority", () => {
  it.each(["always", "pull_requests_only"])(
    "accepts live %s authority without repository admin",
    (mode) => {
      const f = fixture({ ruleset: { current_user_can_bypass: mode } });
      expect(f.verify().delegation).toEqual({
        kind: "ci-ruleset-bypass",
        repositoryId: 123,
        actor: "fixture-bot",
        rulesets: [{ id: 41, mode }],
      });
      expect(f.calls).toEqual([
        "repos/fixture/repo",
        "orgs/fixture/memberships/fixture-bot",
        "repos/fixture/repo/rulesets/41",
      ]);
    },
  );

  it.each([
    { name: "conflict-resolution", changeKind: "conflict-resolution" },
    { name: "read-only writer", authority: { permissions: { push: false } } },
    { name: "foreign repository", authority: { full_name: "other/repo" } },
    {
      name: "foreign organization",
      authority: { owner: { type: "Organization", login: "other" } },
    },
    { name: "inactive membership", membership: { state: "pending" } },
    { name: "different member", membership: { user: { login: "other-bot" } } },
    { name: "unknown role", membership: { role: "other" } },
    { name: "revoked bypass", ruleset: { current_user_can_bypass: "never" } },
    { name: "missing bypass", ruleset: { current_user_can_bypass: undefined } },
    { name: "unknown bypass", ruleset: { current_user_can_bypass: "exempt" } },
    { name: "foreign ruleset", ruleset: { source: "other/repo" } },
    { name: "different ruleset", ruleset: { id: 42 } },
    { name: "organization ruleset", ruleset: { source_type: "Organization" } },
    { name: "tag ruleset", ruleset: { target: "tag" } },
    { name: "inactive ruleset", ruleset: { enforcement: "evaluate" } },
    {
      name: "mixed ruleset",
      ruleset: {
        rules: [{ type: rule.type, parameters: rule.parameters }, { type: "pull_request" }],
      },
    },
    {
      name: "changed rules",
      ruleset: {
        rules: [
          {
            type: rule.type,
            parameters: { ...rule.parameters, strict_required_status_checks_policy: true },
          },
        ],
      },
    },
    { name: "missing effective gate", rules: [] },
    { name: "missing ruleset identity", rules: [{ ...rule, ruleset_id: undefined }] },
    { name: "foreign effective owner", rules: [{ ...rule, ruleset_source: "other/repo" }] },
    { name: "duplicate effective rule", rules: [rule, rule] },
  ])("refuses $name", (options) => {
    expect(() => fixture(options).verify()).toThrow(/Prior-CI admin admission:/);
  });

  it.each(
    [
      [{ context: "openclaw/ci-gate", integration_id: 999 }],
      [
        ...rule.parameters.required_status_checks,
        { context: "Security Review", integration_id: 15368 },
      ],
    ].map((checks) => ({ checks })),
  )("refuses a matching policy with mixed or foreign checks", ({ checks }) => {
    const parameters = { ...rule.parameters, required_status_checks: checks };
    expect(() =>
      fixture({
        rules: [{ ...rule, parameters }],
        ruleset: { rules: [{ type: rule.type, parameters }] },
      }).verify(),
    ).toThrow(/CI-only ruleset bypass/);
  });

  it("does not infer delegation from inaccessible GitHub authority", () => {
    expect(() => fixture({ unavailable: true }).verify()).toThrow("GitHub authority unavailable");
  });

  it("preserves the existing organization-admin route for conflict resolution", () => {
    const f = fixture({
      changeKind: "conflict-resolution",
      authority: { permissions: { admin: true } },
      membership: { role: "admin" },
    });
    expect(f.verify().delegation).toBeUndefined();
    expect(f.calls).toHaveLength(2);
  });
});
