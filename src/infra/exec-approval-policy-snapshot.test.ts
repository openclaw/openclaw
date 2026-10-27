import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeExecApprovalPolicyRules,
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
  it("preserves UTF-8 tuple ordering for arbitrary UTF-16 strings", () => {
    type Rule = ExecApprovalPolicySnapshot["allowlistRules"][number];
    const compare = (left: string | undefined, right: string | undefined): number =>
      left === undefined
        ? right === undefined
          ? 0
          : -1
        : right === undefined
          ? 1
          : Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
    const strings = [
      "",
      "\0",
      "a",
      "a\0",
      "aa",
      "\u007f",
      "\u0080",
      "\u07ff",
      "\u0800",
      "\ud7ff",
      "\ud800",
      "\udbff",
      "\udc00",
      "\udfff",
      "\ue000",
      "\ufffd",
      "\uffff",
      "\u{10000}",
      "\u{10ffff}",
      "\ud800a",
      "\ud800\ud800",
      "\udc00\ud800",
      "\ufffda",
      "\ufffd\ufffd",
      "é",
      "e\u0301",
      "日本語",
      "🦞",
    ];
    let seed = 0x148;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let index = 0; index < 128; index++) {
      strings.push(
        String.fromCharCode(...Array.from({ length: 1 + (next() % 8) }, () => next() & 0xffff)),
      );
    }
    const rules: Rule[] = strings.flatMap((pattern) => [
      { pattern },
      { pattern, argPattern: "" },
      { pattern, argPattern: strings[next() % strings.length] },
      { pattern, argPattern: "", source: "allow-always" },
      { pattern: "same-command", argPattern: pattern },
    ]);
    rules.push({ pattern: "same-command", argPattern: "\ud800" }, { pattern: "", argPattern: "" });
    for (let round = 0; round < 8; round++) {
      for (let index = rules.length - 1; index > 0; index--) {
        const other = next() % (index + 1);
        [rules[index], rules[other]] = [rules[other]!, rules[index]!];
      }
      const expected = [
        ...new Map(
          rules.map((rule) => [
            JSON.stringify([rule.pattern, rule.argPattern ?? null, rule.source ?? null]),
            rule,
          ]),
        ).values(),
      ].toSorted(
        (left, right) =>
          compare(left.pattern, right.pattern) ||
          compare(left.argPattern, right.argPattern) ||
          compare(left.source, right.source),
      );
      const actual = canonicalizeExecApprovalPolicyRules(rules);
      expect(actual).toEqual(expected);
      expect(actual.every((rule, index) => rule === expected[index])).toBe(true);
    }
  });

  it("canonicalizes shuffled policy rules without allocating comparison Buffers", () => {
    const rules = Array.from({ length: 128 }, (_, index) => ({
      pattern: `/usr/local/bin/command-${(index * 73) % 128}`,
      argPattern: `^argument-${index}$`,
    }));
    const from = vi.spyOn(Buffer, "from");
    let allocations: number;
    try {
      canonicalizeExecApprovalPolicyRules(rules);
      allocations = from.mock.calls.length;
    } finally {
      from.mockRestore();
    }
    expect(allocations).toBe(0);
  });

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
