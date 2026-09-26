import { describe, expect, it } from "vitest";
import {
  type ExecApprovalPolicySnapshot,
  normalizeExecApprovalPolicySnapshot,
} from "./exec-approval-policy-snapshot.js";
import { isExecApprovalPolicySnapshotCurrent } from "./exec-approvals-allow-always.js";

const policy: ExecApprovalPolicySnapshot = {
  security: "allowlist",
  ask: "on-miss",
  askFallback: "deny",
  autoAllowSkills: false,
  allowlistRules: [],
};

describe("exec approval policy rule identity", () => {
  it("keeps delimiter-containing rule tuples distinct when normalizing and checking policy", () => {
    const first = { pattern: "command", argPattern: "argument\0tail" };
    const second = { pattern: "command\0argument", argPattern: "tail" };

    expect(
      normalizeExecApprovalPolicySnapshot({
        ...policy,
        allowlistRules: [first, second],
      }),
    ).toEqual({ ...policy, allowlistRules: [first, second] });
    expect(
      isExecApprovalPolicySnapshotCurrent(
        { ...policy, allowlistRules: [first] },
        { ...policy, allowlistRules: [second] },
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "accepts a manual rule upgraded to allow-always alongside an additive grant",
      expectedSource: undefined,
      currentSource: "allow-always" as const,
      accepted: true,
    },
    {
      name: "rejects an allow-always rule downgraded to manual despite an additive grant",
      expectedSource: "allow-always" as const,
      currentSource: undefined,
      accepted: false,
    },
  ])("$name", ({ expectedSource, currentSource, accepted }) => {
    expect(
      isExecApprovalPolicySnapshotCurrent(
        {
          ...policy,
          allowlistRules: [{ pattern: "command", argPattern: "^safe$", source: expectedSource }],
        },
        {
          ...policy,
          allowlistRules: [
            { pattern: "command", argPattern: "^safe$", source: currentSource },
            { pattern: "other-command" },
          ],
        },
      ),
    ).toBe(accepted);
  });
});
