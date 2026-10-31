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

const ciRule = { type: rule.type, parameters: rule.parameters };

function verify(
  options: {
    changeKind?: string;
    authority?: Record<string, unknown>;
    membership?: Record<string, unknown>;
    ruleset?: Record<string, unknown>;
    rules?: Array<Record<string, unknown>>;
    unavailable?: boolean;
  } = {},
) {
  const writerRead = (endpoint: string) => {
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
        rules: [ciRule],
        ...options.ruleset,
      };
    }
    throw new Error("Unexpected writer request: " + endpoint);
  };
  return verifyPriorCiWriterAuthority({
    repository: "fixture/repo",
    actor: "fixture-bot",
    changeKind: options.changeKind ?? "pre-existing-failure",
    policy: { rules: options.rules ?? [rule] },
    writerRead,
  });
}

describe("prior-CI delegated writer authority", () => {
  it("accepts live PR-only authority without repository admin", () => {
    const mode = "pull_requests_only";
    expect(verify({ ruleset: { current_user_can_bypass: mode } }).delegation).toEqual({
      kind: "ci-ruleset-bypass",
      repositoryId: 123,
      actor: "fixture-bot",
      rulesets: [{ id: 41, mode }],
    });
  });

  it.each([
    ["conflict-resolution", "changeKind", "conflict-resolution"],
    ["read-only writer", "authority", { permissions: { push: false } }],
    ["foreign repository", "authority", { full_name: "other/repo" }],
    ["foreign organization", "authority", { owner: { type: "Organization", login: "other" } }],
    ["inactive membership", "membership", { state: "pending" }],
    ["different member", "membership", { user: { login: "other-bot" } }],
    ["unknown role", "membership", { role: "other" }],
    ["foreign ruleset", "ruleset", { source: "other/repo" }],
    ["different ruleset", "ruleset", { id: 42 }],
    ["organization ruleset", "ruleset", { source_type: "Organization" }],
    ["tag ruleset", "ruleset", { target: "tag" }],
    ["inactive ruleset", "ruleset", { enforcement: "evaluate" }],
    ["mixed ruleset", "ruleset", { rules: [ciRule, { type: "pull_request" }] }],
    [
      "changed rules",
      "ruleset",
      {
        rules: [
          {
            ...ciRule,
            parameters: { ...rule.parameters, strict_required_status_checks_policy: true },
          },
        ],
      },
    ],
    ["missing effective gate", "rules", []],
    ["missing ruleset identity", "rules", [{ ...rule, ruleset_id: undefined }]],
    ["foreign effective owner", "rules", [{ ...rule, ruleset_source: "other/repo" }]],
    ["duplicate effective rule", "rules", [rule, rule]],
  ] as const)("refuses %s", (_name, field, value) => {
    expect(() => verify({ [field]: value })).toThrow(/Prior-CI admin admission:/);
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
      verify({
        rules: [{ ...rule, parameters }],
        ruleset: { rules: [{ ...ciRule, parameters }] },
      }),
    ).toThrow(/CI-only ruleset bypass/);
  });

  it("does not infer delegation from inaccessible GitHub authority", () => {
    expect(() => verify({ unavailable: true })).toThrow("GitHub authority unavailable");
  });
});
