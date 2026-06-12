// Covers exec denylist (STOP-list) screening over analyzed command segments.
import { describe, expect, it } from "vitest";
import {
  analyzeShellCommand,
  evaluateExecDenylist,
  sanitizeExecDenylistEntries,
  type ExecCommandSegment,
  type ExecDenylistEntry,
} from "./exec-approvals.js";

function evaluateCommand(command: string, patterns: string[], platform = "linux") {
  const analysis = analyzeShellCommand({ command, platform });
  return evaluateExecDenylist({
    denylist: patterns.map((pattern): ExecDenylistEntry => ({ pattern })),
    segments: analysis.segments,
    analysisOk: analysis.ok,
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
  it("matches a denylisted command", () => {
    const evaluation = evaluateCommand("git push --force origin main", ["git push --force*"]);
    expect(evaluation.matched).toBe(true);
    expect(evaluation.unanalyzable).toBe(false);
    expect(evaluation.entry?.pattern).toBe("git push --force*");
  });

  it("matches flags appearing later in the command", () => {
    const evaluation = evaluateCommand("git push origin main --force", ["git push*--force*"]);
    expect(evaluation.matched).toBe(true);
  });

  it("does not match commands outside the denylist", () => {
    const evaluation = evaluateCommand("git push origin main", ["git push*--force*"]);
    expect(evaluation.matched).toBe(false);
    expect(evaluation.entry).toBeNull();
  });

  it("matches path-prefixed executables through the basename variant", () => {
    const evaluation = evaluateCommand("/usr/bin/git push --force", ["git push --force*"]);
    expect(evaluation.matched).toBe(true);
  });

  it("matches denylisted parts inside command chains", () => {
    const evaluation = evaluateCommand("echo ok && git push --force", ["git push*--force*"]);
    expect(evaluation.matched).toBe(true);
  });

  it("matches denylisted payloads inside POSIX inline shell wrappers", () => {
    const evaluation = evaluateCommand(`bash -c "git push --force"`, ["git push*--force*"]);
    expect(evaluation.matched).toBe(true);
  });

  it("does not match quoted denylist text passed as data arguments", () => {
    const evaluation = evaluateCommand(`grep "git push --force" README.md`, ["git push*--force*"]);
    expect(evaluation.matched).toBe(false);
  });

  it("treats unanalyzable commands as conservative hits when a denylist exists", () => {
    const evaluation = evaluateExecDenylist({
      denylist: [{ pattern: "git push*--force*" }],
      segments: [],
      analysisOk: false,
      platform: "linux",
    });
    expect(evaluation.matched).toBe(true);
    expect(evaluation.unanalyzable).toBe(true);
    expect(evaluation.entry).toBeNull();
  });

  it("never matches when the denylist is empty, even for unanalyzable commands", () => {
    const evaluation = evaluateExecDenylist({
      denylist: [],
      segments: [],
      analysisOk: false,
      platform: "linux",
    });
    expect(evaluation.matched).toBe(false);
    expect(evaluation.unanalyzable).toBe(false);
  });

  it("never matches when all entries are malformed", () => {
    const evaluation = evaluateExecDenylist({
      denylist: [{ pattern: "   " }] as ExecDenylistEntry[],
      segments: [],
      analysisOk: false,
      platform: "linux",
    });
    expect(evaluation.matched).toBe(false);
  });

  it("treats nested inline wrappers beyond the depth cap as conservative hits", () => {
    const evaluation = evaluateCommand(`bash -c "bash -c \\"bash -c 'git push --force'\\""`, [
      "git push*--force*",
    ]);
    expect(evaluation.matched).toBe(true);
  });

  it("treats cmd.exe inline payloads as conservative hits", () => {
    const evaluation = evaluateExecDenylist({
      denylist: [{ pattern: "git push*--force*" }],
      segments: [syntheticSegment(["cmd.exe", "/c", "git push --force"])],
      analysisOk: true,
      platform: "win32",
    });
    expect(evaluation.matched).toBe(true);
    expect(evaluation.unanalyzable).toBe(true);
  });

  it("treats powershell inline payloads as conservative hits", () => {
    const evaluation = evaluateExecDenylist({
      denylist: [{ pattern: "git push*--force*" }],
      segments: [syntheticSegment(["pwsh", "-Command", "git push --force"])],
      analysisOk: true,
      platform: "linux",
    });
    expect(evaluation.matched).toBe(true);
    expect(evaluation.unanalyzable).toBe(true);
  });

  it("matches case-insensitively on Windows", () => {
    const evaluation = evaluateExecDenylist({
      denylist: [{ pattern: "git push*--force*" }],
      segments: [syntheticSegment(["GIT", "push", "--FORCE"])],
      analysisOk: true,
      platform: "win32",
    });
    expect(evaluation.matched).toBe(true);
  });

  it("matches case-sensitively on POSIX", () => {
    const evaluation = evaluateExecDenylist({
      denylist: [{ pattern: "git push*--force*" }],
      segments: [syntheticSegment(["GIT", "push", "--FORCE"])],
      analysisOk: true,
      platform: "linux",
    });
    expect(evaluation.matched).toBe(false);
  });

  it("reports the first matching entry for operator-facing messages", () => {
    const evaluation = evaluateCommand("launchctl kickstart -k system/foo", [
      "rm -rf*",
      "launchctl*",
    ]);
    expect(evaluation.matched).toBe(true);
    expect(evaluation.entry?.pattern).toBe("launchctl*");
    expect(evaluation.matchedText).toContain("launchctl");
  });
});
