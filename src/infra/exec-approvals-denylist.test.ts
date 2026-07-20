// Covers exec denylist (STOP-list) screening over analyzed command segments.
import { describe, expect, it } from "vitest";
import {
  evaluateExecDenylist,
  formatUnanalyzableDenylistHardDenyMessage,
  sanitizeExecDenylistEntries,
  shouldHardDenyUnanalyzableDenylistHit,
  type ExecCommandSegment,
} from "./exec-approvals.js";
import type { ExecDenylistEntry } from "./exec-approvals.types.js";
import { planShellAuthorization } from "./exec-authorization-plan.js";

async function evaluateCommand(command: string, patterns: string[], platform = "linux") {
  // Upstream replaced sync analyzeShellCommand with async shell planning.
  const plan = await planShellAuthorization({ command, platform });
  const segments = plan.ok
    ? plan.groups.flatMap((group) => group.candidates.map((candidate) => candidate.sourceSegment))
    : [];
  return evaluateExecDenylist({
    denylist: patterns.map((pattern): ExecDenylistEntry => ({ pattern })),
    segments,
    analysisOk: plan.ok,
    platform,
  });
}

function syntheticSegment(argv: string[]): ExecCommandSegment {
  return { raw: argv.join(" "), argv, resolution: null };
}

describe("sanitizeExecDenylistEntries", () => {
  it("keeps valid entries and preserves array identity when nothing changes", () => {
    const entries: ExecDenylistEntry[] = [{ pattern: "git push*--force*", reason: "stop list" }];
    expect(sanitizeExecDenylistEntries(entries)).toBe(entries);
  });

  it("drops malformed entries and trims patterns", () => {
    const sanitized = sanitizeExecDenylistEntries([
      { pattern: "  git push*  " },
      { pattern: "   " },
      { pattern: 42 },
      "git push*",
      null,
      {},
    ]);
    expect(sanitized).toEqual([{ pattern: "git push*" }]);
  });

  it("returns an empty list for non-array input", () => {
    expect(sanitizeExecDenylistEntries(undefined)).toEqual([]);
    expect(sanitizeExecDenylistEntries("git push*")).toEqual([]);
  });
});

describe("evaluateExecDenylist", () => {
  it("matches a denylisted command", async () => {
    const evaluation = await evaluateCommand("git push --force origin main", ["git push --force*"]);
    expect(evaluation.matched).toBe(true);
    expect(evaluation.unanalyzable).toBe(false);
    expect(evaluation.entry?.pattern).toBe("git push --force*");
  });

  it("matches flags appearing later in the command", async () => {
    const evaluation = await evaluateCommand("git push origin main --force", ["git push*--force*"]);
    expect(evaluation.matched).toBe(true);
  });

  it("does not match commands outside the denylist", async () => {
    const evaluation = await evaluateCommand("git push origin main", ["git push*--force*"]);
    expect(evaluation.matched).toBe(false);
    expect(evaluation.entry).toBeNull();
  });

  it("matches path-prefixed executables through the basename variant", async () => {
    const evaluation = await evaluateCommand("/usr/bin/git push --force", ["git push --force*"]);
    expect(evaluation.matched).toBe(true);
  });

  it("matches denylisted parts inside command chains", async () => {
    const evaluation = await evaluateCommand("echo ok && git push --force", ["git push*--force*"]);
    expect(evaluation.matched).toBe(true);
  });

  it("matches denylisted payloads inside POSIX inline shell wrappers", async () => {
    const evaluation = await evaluateCommand(`bash -c "git push --force"`, ["git push*--force*"]);
    expect(evaluation.matched).toBe(true);
  });

  it("does not match quoted denylist text passed as data arguments", async () => {
    const evaluation = await evaluateCommand(`grep "git push --force" README.md`, [
      "git push*--force*",
    ]);
    expect(evaluation.matched).toBe(false);
  });

  it("treats unanalyzable commands as conservative hits when a denylist exists", async () => {
    const evaluation = await evaluateExecDenylist({
      denylist: [{ pattern: "git push*--force*" }],
      segments: [],
      analysisOk: false,
      platform: "linux",
    });
    expect(evaluation.matched).toBe(true);
    expect(evaluation.unanalyzable).toBe(true);
    expect(evaluation.entry).toBeNull();
  });

  it("never matches when the denylist is empty, even for unanalyzable commands", async () => {
    const evaluation = await evaluateExecDenylist({
      denylist: [],
      segments: [],
      analysisOk: false,
      platform: "linux",
    });
    expect(evaluation.matched).toBe(false);
    expect(evaluation.unanalyzable).toBe(false);
  });

  it("never matches when all entries are malformed", async () => {
    const evaluation = await evaluateExecDenylist({
      denylist: [{ pattern: "   " }] as ExecDenylistEntry[],
      segments: [],
      analysisOk: false,
      platform: "linux",
    });
    expect(evaluation.matched).toBe(false);
  });

  it("treats nested inline wrappers beyond the depth cap as conservative hits", async () => {
    const evaluation = await evaluateCommand(`bash -c "bash -c \\"bash -c 'git push --force'\\""`, [
      "git push*--force*",
    ]);
    expect(evaluation.matched).toBe(true);
  });

  it("treats cmd.exe inline payloads as conservative hits", async () => {
    const evaluation = await evaluateExecDenylist({
      denylist: [{ pattern: "git push*--force*" }],
      segments: [syntheticSegment(["cmd.exe", "/c", "git push --force"])],
      analysisOk: true,
      platform: "win32",
    });
    expect(evaluation.matched).toBe(true);
    expect(evaluation.unanalyzable).toBe(true);
  });

  it("treats powershell inline payloads as conservative hits", async () => {
    const evaluation = await evaluateExecDenylist({
      denylist: [{ pattern: "git push*--force*" }],
      segments: [syntheticSegment(["pwsh", "-Command", "git push --force"])],
      analysisOk: true,
      platform: "linux",
    });
    expect(evaluation.matched).toBe(true);
    expect(evaluation.unanalyzable).toBe(true);
  });

  it("matches case-insensitively on Windows", async () => {
    const evaluation = await evaluateExecDenylist({
      denylist: [{ pattern: "git push*--force*" }],
      segments: [syntheticSegment(["GIT", "push", "--FORCE"])],
      analysisOk: true,
      platform: "win32",
    });
    expect(evaluation.matched).toBe(true);
  });

  it("matches case-sensitively on POSIX", async () => {
    const evaluation = await evaluateExecDenylist({
      denylist: [{ pattern: "git push*--force*" }],
      segments: [syntheticSegment(["GIT", "push", "--FORCE"])],
      analysisOk: true,
      platform: "linux",
    });
    expect(evaluation.matched).toBe(false);
  });

  it("reports the first matching entry for operator-facing messages", async () => {
    const evaluation = await evaluateCommand("launchctl kickstart -k system/foo", [
      "rm -rf*",
      "launchctl*",
    ]);
    expect(evaluation.matched).toBe(true);
    expect(evaluation.entry?.pattern).toBe("launchctl*");
    expect(evaluation.matchedText).toContain("launchctl");
  });
});

describe("shouldHardDenyUnanalyzableDenylistHit", () => {
  it("hard-denies only yolo + unanalyzable hits", () => {
    const unanalyzable = {
      matched: true,
      entry: null,
      matchedText: null,
      unanalyzable: true,
    };
    const patternHit = {
      matched: true,
      entry: { pattern: "gws auth logout*" },
      matchedText: "gws auth logout",
      unanalyzable: false,
    };
    expect(
      shouldHardDenyUnanalyzableDenylistHit({
        security: "full",
        ask: "off",
        evaluation: unanalyzable,
      }),
    ).toBe(true);
    expect(
      shouldHardDenyUnanalyzableDenylistHit({
        security: "full",
        ask: "off",
        evaluation: patternHit,
      }),
    ).toBe(false);
    expect(
      shouldHardDenyUnanalyzableDenylistHit({
        security: "full",
        ask: "on-miss",
        evaluation: unanalyzable,
      }),
    ).toBe(false);
  });

  it("formats a remediation message for opaque shell", () => {
    const message = formatUnanalyzableDenylistHardDenyMessage("cat file 2>&1");
    expect(message).toContain("lisa-safe");
    expect(message).toContain("Refused command: cat file 2>&1");
  });
});
