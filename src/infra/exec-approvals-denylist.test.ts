import { describe, expect, it } from "vitest";
import {
  collectExecDenylistErrors,
  evaluateExecDenylist,
  formatExecDenylistWarning,
  normalizeExecDenylist,
  resolveEffectiveExecDenylist,
} from "./exec-approvals-denylist.js";
import { requiresExecApproval } from "./exec-approvals.js";

function seg(argv: string[], raw?: string) {
  return raw ? { argv, raw } : { argv };
}

describe("normalizeExecDenylist", () => {
  it("trims patterns and coerces reasons", () => {
    expect(normalizeExecDenylist([{ pattern: "  git push*--force*  ", reason: " x " }])).toEqual([
      {
        pattern: "git push*--force*",
        reason: "x",
      },
    ]);
    expect(normalizeExecDenylist([{ pattern: "launchctl*" }])).toEqual([
      {
        pattern: "launchctl*",
      },
    ]);
  });

  it("drops malformed entries (self-healing file surface)", () => {
    const out = normalizeExecDenylist([
      { pattern: "rm -rf **" },
      { pattern: "" },
      { pattern: "   " },
      { reason: "no pattern" },
      "not-an-object",
      null,
      42,
      { pattern: 5 },
    ]);
    expect(out).toEqual([{ pattern: "rm -rf **" }]);
  });

  it("de-duplicates identical entries", () => {
    const out = normalizeExecDenylist([
      { pattern: "a*", reason: "r" },
      { pattern: "a*", reason: "r" },
      { pattern: "a*" },
    ]);
    expect(out).toEqual([{ pattern: "a*", reason: "r" }, { pattern: "a*" }]);
  });
});

describe("collectExecDenylistErrors (config validation)", () => {
  it("accepts absent or valid denylists", () => {
    expect(collectExecDenylistErrors(undefined, "tools.exec.denylist")).toEqual([]);
    expect(
      collectExecDenylistErrors([{ pattern: "git push*--force*", reason: "history rewrite" }], "p"),
    ).toEqual([]);
  });

  it("rejects malformed entries loudly", () => {
    expect(collectExecDenylistErrors("nope", "tools.exec.denylist")).toEqual([
      "tools.exec.denylist must be an array of { pattern, reason? } entries",
    ]);
    const errors = collectExecDenylistErrors(
      [{ pattern: "" }, { reason: "x" }, { pattern: "ok", reason: 5 }, "str"],
      "tools.exec.denylist",
    );
    expect(errors).toEqual([
      "tools.exec.denylist[0].pattern must be a non-empty string",
      "tools.exec.denylist[1].pattern must be a non-empty string",
      "tools.exec.denylist[2].reason must be a string when present",
      'tools.exec.denylist[3] must be an object with a non-empty "pattern"',
    ]);
  });
});

describe("resolveEffectiveExecDenylist (both config layers, union)", () => {
  it("unions file-layer and config-layer entries and de-dupes", () => {
    const fileLayer = [{ pattern: "git push*--force*", reason: "history rewrite" }];
    const configLayer = [
      { pattern: "launchctl*" },
      { pattern: "git push*--force*", reason: "history rewrite" },
    ];
    const out = resolveEffectiveExecDenylist({ layers: [fileLayer, configLayer, undefined] });
    expect(out).toEqual([
      { pattern: "git push*--force*", reason: "history rewrite" },
      { pattern: "launchctl*" },
    ]);
  });

  it("a deny in either layer is honored (stricter-wins)", () => {
    // config layer alone
    const configOnly = resolveEffectiveExecDenylist({
      layers: [undefined, [{ pattern: "rm -rf **" }]],
    });
    expect(configOnly).toEqual([{ pattern: "rm -rf **" }]);
  });
});

describe("evaluateExecDenylist", () => {
  const denylist = [{ pattern: "git push*--force*", reason: "history rewrite" }];

  it("returns no match for empty denylist", () => {
    expect(
      evaluateExecDenylist({
        command: "git push --force",
        segments: [seg(["git", "push", "--force"])],
        denylist: [],
        analysisOk: true,
      }),
    ).toEqual({ match: null, conservativeApproval: false });
  });

  it("exact-command deny via full pattern", () => {
    const exactPattern = "launchctl unload -w /Library/LaunchDaemons/x.plist";
    const exact = [{ pattern: exactPattern }];
    const result = evaluateExecDenylist({
      command: "launchctl unload -w /Library/LaunchDaemons/x.plist",
      segments: [seg(["launchctl", "unload", "-w", "/Library/LaunchDaemons/x.plist"])],
      denylist: exact,
      analysisOk: true,
    });
    expect(result.match).toEqual({ pattern: exactPattern });
  });

  it("pattern (glob) deny against segment argv text", () => {
    const result = evaluateExecDenylist({
      command: "git push --force origin main",
      segments: [seg(["git", "push", "--force", "origin", "main"])],
      denylist,
      analysisOk: true,
    });
    expect(result.match).toEqual({ pattern: "git push*--force*", reason: "history rewrite" });
  });

  it("basename variant matches absolute executable path", () => {
    const result = evaluateExecDenylist({
      command: "/usr/bin/git push --force origin main",
      segments: [seg(["/usr/bin/git", "push", "--force", "origin", "main"])],
      denylist,
      analysisOk: true,
    });
    expect(result.match?.pattern).toBe("git push*--force*");
  });

  it("does not match unrelated commands", () => {
    const result = evaluateExecDenylist({
      command: "git status",
      segments: [seg(["git", "status"])],
      denylist,
      analysisOk: true,
    });
    expect(result).toEqual({ match: null, conservativeApproval: false });
  });

  it("conservative approval when a denylist is set but the command is unanalyzable", () => {
    const result = evaluateExecDenylist({
      command: "", // nothing screenable
      segments: [],
      denylist,
      analysisOk: false,
    });
    expect(result).toEqual({ match: null, conservativeApproval: true });
  });

  it("matches the raw inner payload of a shell wrapper segment", () => {
    const result = evaluateExecDenylist({
      command: 'bash -c "git push --force origin main"',
      segments: [seg(["git", "push", "--force", "origin", "main"], "git push --force origin main")],
      denylist,
      analysisOk: true,
    });
    expect(result.match?.pattern).toBe("git push*--force*");
  });

  it("formats a warning with pattern and reason", () => {
    expect(
      formatExecDenylistWarning({ pattern: "git push*--force*", reason: "history rewrite" }),
    ).toBe(
      "Warning: command matches exec denylist entry git push*--force* (history rewrite); explicit approval is required.",
    );
    expect(formatExecDenylistWarning({ pattern: "launchctl*" })).toBe(
      "Warning: command matches exec denylist entry launchctl*; explicit approval is required.",
    );
  });
});

describe("requiresExecApproval denylist precedence", () => {
  it("deny beats ask=off + security=full", () => {
    expect(
      requiresExecApproval({
        ask: "off",
        security: "full",
        analysisOk: true,
        allowlistSatisfied: true,
        denylisted: true,
      }),
    ).toBe(true);
  });

  it("deny beats a satisfied allowlist", () => {
    // Without denylist, a satisfied allowlist at ask=off/full does not require approval.
    expect(
      requiresExecApproval({
        ask: "off",
        security: "allowlist",
        analysisOk: true,
        allowlistSatisfied: true,
      }),
    ).toBe(false);
    // With denylist, it must.
    expect(
      requiresExecApproval({
        ask: "off",
        security: "allowlist",
        analysisOk: true,
        allowlistSatisfied: true,
        denylisted: true,
      }),
    ).toBe(true);
  });

  it("deny beats a durable allow-always grant", () => {
    expect(
      requiresExecApproval({
        ask: "off",
        security: "full",
        analysisOk: true,
        allowlistSatisfied: true,
        durableApprovalSatisfied: true,
        denylisted: true,
      }),
    ).toBe(true);
    // Sanity: durable trust alone (no denylist) does NOT require approval.
    expect(
      requiresExecApproval({
        ask: "off",
        security: "full",
        analysisOk: true,
        allowlistSatisfied: true,
        durableApprovalSatisfied: true,
      }),
    ).toBe(false);
  });

  it("no denylist leaves existing behavior unchanged", () => {
    expect(
      requiresExecApproval({
        ask: "off",
        security: "full",
        analysisOk: true,
        allowlistSatisfied: true,
      }),
    ).toBe(false);
  });
});
