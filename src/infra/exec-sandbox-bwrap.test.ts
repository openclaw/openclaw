import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { AccessPolicyConfig } from "../config/types.tools.js";
import {
  _warnBwrapFileDenyOnce,
  generateBwrapArgs,
  wrapCommandWithBwrap,
} from "./exec-sandbox-bwrap.js";

const HOME = os.homedir();

// bwrap is Linux-only — skip the generateBwrapArgs tests on other platforms so
// Windows/macOS CI does not fail on fs.statSync calls against Unix-only paths
// like /etc/hosts that don't exist there.
describe.skipIf(process.platform !== "linux")("generateBwrapArgs", () => {
  it("starts with --ro-bind / / when default allows reads", () => {
    const config: AccessPolicyConfig = { default: "r--" };
    const args = generateBwrapArgs(config, HOME);
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
  });

  it("does not use --ro-bind / / when default is ---", () => {
    const config: AccessPolicyConfig = { default: "---" };
    const args = generateBwrapArgs(config, HOME);
    // Should not contain root bind
    const rootBindIdx = args.findIndex(
      (a, i) => a === "--ro-bind" && args[i + 1] === "/" && args[i + 2] === "/",
    );
    expect(rootBindIdx).toBe(-1);
  });

  it("ends with --", () => {
    const config: AccessPolicyConfig = { default: "r--" };
    const args = generateBwrapArgs(config, HOME);
    expect(args[args.length - 1]).toBe("--");
  });

  it("adds --tmpfs for each deny entry", () => {
    const config: AccessPolicyConfig = {
      deny: [`${HOME}/.ssh/**`, `${HOME}/.gnupg/**`],
      default: "r--",
    };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain(`${HOME}/.ssh`);
    expect(tmpfsMounts).toContain(`${HOME}/.gnupg`);
  });

  it("expands ~ in deny patterns using homeDir", () => {
    const config: AccessPolicyConfig = {
      deny: ["~/.ssh/**"],
      default: "r--",
    };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain(`${HOME}/.ssh`);
  });

  it("adds --bind for paths with w bit in rules", () => {
    const config: AccessPolicyConfig = {
      rules: { [`${HOME}/workspace/**`]: "rw-" },
      default: "r--",
    };
    const args = generateBwrapArgs(config, HOME);
    const bindPairs: string[] = [];
    for (let i = 0; i < args.length - 2; i++) {
      if (args[i] === "--bind-try") {
        bindPairs.push(args[i + 1]);
      }
    }
    expect(bindPairs).toContain(`${HOME}/workspace`);
  });

  it("does not add --bind for read-only rules on permissive base", () => {
    const config: AccessPolicyConfig = {
      rules: { "/usr/bin/**": "r--" },
      default: "r--",
    };
    const args = generateBwrapArgs(config, HOME);
    // /usr/bin should NOT appear as a --bind-try (it's already ro-bound via /)
    const bindPairs: string[] = [];
    for (let i = 0; i < args.length - 2; i++) {
      if (args[i] === "--bind-try") {
        bindPairs.push(args[i + 1]);
      }
    }
    expect(bindPairs).not.toContain("/usr/bin");
  });

  it("deny entry tmpfs appears in args regardless of rule for that path", () => {
    const config: AccessPolicyConfig = {
      rules: { [`${HOME}/**`]: "rwx" },
      deny: [`${HOME}/.ssh/**`],
      default: "r--",
    };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain(`${HOME}/.ssh`);
  });

  it("does not crash on empty config", () => {
    expect(() => generateBwrapArgs({}, HOME)).not.toThrow();
  });

  it("adds --proc /proc in permissive mode so /proc is accessible inside the sandbox", () => {
    // --ro-bind / / does not propagate kernel filesystems (procfs) into the new
    // mount namespace; without --proc /proc, shells and Python fail in the sandbox.
    const args = generateBwrapArgs({ default: "r--" }, HOME);
    const procIdx = args.indexOf("--proc");
    expect(procIdx).toBeGreaterThan(-1);
    expect(args[procIdx + 1]).toBe("/proc");
  });

  it("adds --tmpfs /tmp in permissive mode", () => {
    const config: AccessPolicyConfig = { default: "r--" };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain("/tmp");
  });

  it("does not add --tmpfs /tmp in restrictive mode even with no explicit /tmp rule", () => {
    // Regression guard: the defaultAllowsRead guard on the /tmp block must prevent
    // a writable tmpfs being mounted under default:"---" when no /tmp rule exists.
    // explicitTmpPerm === null is true (no rule), but defaultAllowsRead is false,
    // so the entire /tmp block must be skipped.
    const config: AccessPolicyConfig = { default: "---" };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).not.toContain("/tmp");
  });

  it("skips --tmpfs /tmp in permissive mode when policy explicitly restricts /tmp writes", () => {
    // A rule "/tmp/**": "r--" means the user wants /tmp read-only; the base --ro-bind / /
    // already makes it readable. Adding --tmpfs /tmp would silently grant write access.
    const config: AccessPolicyConfig = { default: "r--", rules: { "/tmp/**": "r--" } };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).not.toContain("/tmp");
  });

  it("skips --tmpfs /tmp when an explicit write rule covers /tmp (rules loop emits --bind-try)", () => {
    // Regression: the old code also emitted --tmpfs /tmp when explicitTmpPerm[1] === "w",
    // but the rules loop always follows with --bind-try /tmp /tmp which wins (last mount wins
    // in bwrap). The --tmpfs was dead code. Confirm: explicit rw- rule → no --tmpfs /tmp,
    // but --bind-try /tmp IS present.
    const config: AccessPolicyConfig = { default: "r--", rules: { "/tmp/**": "rw-" } };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    const bindMounts = args
      .map((a, i) => (a === "--bind-try" ? args[i + 1] : null))
      .filter(Boolean);
    expect(tmpfsMounts).not.toContain("/tmp");
    expect(bindMounts).toContain("/tmp");
  });

  it("does not add --tmpfs /tmp in restrictive mode (default: ---)", () => {
    const config: AccessPolicyConfig = { default: "---" };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).not.toContain("/tmp");
  });

  it('"---" rule in permissive mode gets --tmpfs overlay to block reads', () => {
    // With default:"r--", --ro-bind / / makes everything readable. A narrowing
    // rule like "/secret/**": "---" must overlay --tmpfs so the path is hidden.
    const config: AccessPolicyConfig = {
      default: "r--",
      rules: { [`${HOME}/secret/**`]: "---" },
    };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain(`${HOME}/secret`);
    // Must NOT produce a bind mount for this path.
    const bindMounts = args
      .map((a, i) => (a === "--bind-try" ? args[i + 1] : null))
      .filter(Boolean);
    expect(bindMounts).not.toContain(`${HOME}/secret`);
  });

  it('"--x" rule in permissive mode gets --tmpfs overlay to block reads', () => {
    // Execute-only rules have no read bit — same treatment as "---" in permissive mode.
    const config: AccessPolicyConfig = {
      default: "r--",
      rules: { [`${HOME}/scripts/**`]: "--x" },
    };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain(`${HOME}/scripts`);
  });

  it('"---" rules do not create --ro-bind-try mounts in restrictive mode', () => {
    // A rule with "---" permission should NOT produce any bwrap mount — the
    // restrictive base already denies by not mounting. Emitting --ro-bind-try
    // for a "---" rule would silently grant read access to paths that should
    // be fully blocked.
    const config: AccessPolicyConfig = {
      default: "---",
      rules: {
        [`${HOME}/workspace/**`]: "rwx", // allowed: should produce --bind-try
        [`${HOME}/workspace/private/**`]: "---", // denied: must NOT produce any mount
      },
    };
    const args = generateBwrapArgs(config, HOME);
    const roBound = args
      .map((a, i) => (a === "--ro-bind-try" ? args[i + 1] : null))
      .filter(Boolean);
    // "---" rule must not produce a read-only bind
    expect(roBound).not.toContain(`${HOME}/workspace/private`);
    // "rwx" rule must produce a read-write bind (sanity check)
    const rwBound = args.map((a, i) => (a === "--bind-try" ? args[i + 1] : null)).filter(Boolean);
    expect(rwBound).toContain(`${HOME}/workspace`);
  });

  it('"--x" rules do not create --ro-bind-try mounts in restrictive mode', () => {
    // Same as "---" case: execute-only rules also must not emit read mounts.
    const config: AccessPolicyConfig = {
      default: "---",
      rules: { [`${HOME}/scripts/**`]: "--x" },
    };
    const args = generateBwrapArgs(config, HOME);
    const roBound = args
      .map((a, i) => (a === "--ro-bind-try" ? args[i + 1] : null))
      .filter(Boolean);
    expect(roBound).not.toContain(`${HOME}/scripts`);
  });

  it('"-w-" rule in restrictive mode emits --bind-try so writes do not silently fail', () => {
    // A write-only rule ("-w-") under default:"---" now emits --bind-try so the path
    // exists in the bwrap namespace and writes succeed. bwrap cannot enforce
    // write-without-read at the mount level; reads are also permitted at the OS layer,
    // but the tool layer still denies read tool calls per the "-w-" rule.
    const config: AccessPolicyConfig = {
      default: "---",
      rules: { [`${HOME}/logs/**`]: "-w-" },
    };
    const args = generateBwrapArgs(config, HOME);
    const bindMounts = args
      .map((a, i) => (a === "--bind-try" ? args[i + 1] : null))
      .filter(Boolean);
    expect(bindMounts).toContain(`${HOME}/logs`);
  });

  it('"-w-" rule in permissive mode emits --bind-try (write upgrade, reads already allowed)', () => {
    // Under default:"r--", --ro-bind / / already grants reads everywhere.
    // A "-w-" rule upgrades to rw for that path — reads are not newly leaked
    // since the base already allowed them.
    const config: AccessPolicyConfig = {
      default: "r--",
      rules: { [`${HOME}/output/**`]: "-w-" },
    };
    const args = generateBwrapArgs(config, HOME);
    const bindMounts = args
      .map((a, i) => (a === "--bind-try" ? args[i + 1] : null))
      .filter(Boolean);
    expect(bindMounts).toContain(`${HOME}/output`);
  });

  it("skips mid-path wildcard patterns — truncated prefix would be too broad", () => {
    // "/home/*/.ssh/**" truncates to "/home" — far too broad for a bwrap mount.
    // The pattern must be silently ignored rather than binding /home.
    const fakeHome = "/home/testuser";
    const config: AccessPolicyConfig = {
      default: "r--",
      deny: ["/home/*/.ssh/**"],
      rules: { "/home/*/.config/**": "---" },
    };
    const args = generateBwrapArgs(config, fakeHome);
    const allMountTargets = args
      .map((a, i) =>
        ["--tmpfs", "--bind-try", "--ro-bind-try"].includes(args[i - 1] ?? "") ? a : null,
      )
      .filter(Boolean);
    // "/home" must NOT appear as a mount target — it's the over-broad truncation.
    expect(allMountTargets).not.toContain("/home");
  });

  it("suffix-glob rule uses parent directory as mount target, not literal prefix", () => {
    // "/var/log/secret*" must mount "/var/log", NOT the literal prefix "/var/log/secret"
    // which is not a directory and leaves entries like "/var/log/secret.old" unprotected.
    const config: AccessPolicyConfig = {
      default: "r--",
      deny: ["/var/log/secret*"],
    };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain("/var/log");
    expect(tmpfsMounts).not.toContain("/var/log/secret");
  });

  it("emits broader mounts before narrower ones so specific overrides win", () => {
    // ~/dev/** is rw, ~/dev/secret/** is ro. The ro bind MUST come after the rw
    // bind in the args so it takes precedence in bwrap's mount evaluation.
    const config: AccessPolicyConfig = {
      // Deliberately insert secret first so Object.entries() would yield it first
      // without sorting — proving the sort is what fixes the order.
      rules: {
        [`${HOME}/dev/secret/**`]: "r--",
        [`${HOME}/dev/**`]: "rw-",
      },
      default: "---",
    };
    const args = generateBwrapArgs(config, HOME);
    const bindArgs = args.filter((a) => a === "--bind-try" || a === "--ro-bind-try");
    const bindPaths = args
      .map((a, i) => (args[i - 1] === "--bind-try" || args[i - 1] === "--ro-bind-try" ? a : null))
      .filter(Boolean);

    const devIdx = bindPaths.indexOf(`${HOME}/dev`);
    const secretIdx = bindPaths.indexOf(`${HOME}/dev/secret`);
    // ~/dev (broader) must appear before ~/dev/secret (narrower).
    expect(devIdx).toBeGreaterThanOrEqual(0);
    expect(secretIdx).toBeGreaterThan(devIdx);
    // And the types must be right.
    expect(bindArgs[devIdx]).toBe("--bind-try");
    expect(bindArgs[secretIdx]).toBe("--ro-bind-try");
  });

  it('script override "-w-" under restrictive default emits --bind-try, not --tmpfs', () => {
    // Greptile: permAllowsWrite && (r || defaultR) condition was wrong — for -w- under ---
    // both flags are false so it fell to else → --tmpfs, silently blocking writes.
    // Fix: any write-granting override always emits --bind-try.
    const config: AccessPolicyConfig = {
      default: "---",
      rules: { [`${HOME}/workspace/**`]: "rwx" },
    };
    const overrides = { [`${HOME}/logs/**`]: "-w-" as const };
    const args = generateBwrapArgs(config, HOME, overrides);
    const bindMounts = args
      .map((a, i) => (a === "--bind-try" ? args[i + 1] : null))
      .filter(Boolean);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(bindMounts).toContain(`${HOME}/logs`);
    expect(tmpfsMounts).not.toContain(`${HOME}/logs`);
  });

  it("skips --tmpfs for deny[] entry that resolves to an existing file (not a directory)", () => {
    // /etc/hosts is a file on both macOS and Linux; bwrap --tmpfs rejects file paths.
    // The deny entry is expanded to "/etc/hosts/**" by validateAccessPolicyConfig, and
    // patternToPath strips the "/**" back to "/etc/hosts". generateBwrapArgs must not
    // emit "--tmpfs /etc/hosts" — it should be silently skipped.
    const config: AccessPolicyConfig = { default: "r--", deny: ["/etc/hosts/**"] };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).not.toContain("/etc/hosts");
  });

  it("emits a console.error warning when a file-specific deny[] entry is skipped", () => {
    // Use /etc/passwd (always a file) rather than /etc/hosts which is already in
    // _bwrapFileDenyWarnedPaths from the generateBwrapArgs test above.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      _warnBwrapFileDenyOnce("/etc/passwd");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("/etc/passwd"));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("parent directory"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("still emits --tmpfs for deny[] entry that resolves to a directory", () => {
    // Non-existent paths are treated as directories (forward-protection).
    const config: AccessPolicyConfig = { default: "r--", deny: [`${HOME}/.nonexistent-dir/**`] };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain(`${HOME}/.nonexistent-dir`);
  });

  it("trailing-slash rule is treated as /** and resolves to correct path", () => {
    // "/tmp/" is shorthand for "/tmp/**" — must produce the same mount target
    // and sort-order length as an explicit "/tmp/**" rule.
    const withSlash = generateBwrapArgs({ default: "---", rules: { "/tmp/": "rw-" } }, HOME);
    const withGlob = generateBwrapArgs({ default: "---", rules: { "/tmp/**": "rw-" } }, HOME);
    const bindOf = (args: string[]) =>
      args.map((a, i) => (args[i - 1] === "--bind-try" ? a : null)).filter(Boolean);
    expect(bindOf(withSlash)).toContain("/tmp");
    expect(bindOf(withSlash)).toEqual(bindOf(withGlob));
  });
});

describe("wrapCommandWithBwrap", () => {
  it("starts with bwrap", () => {
    const result = wrapCommandWithBwrap("ls /tmp", { default: "r--" }, HOME);
    expect(result).toMatch(/^bwrap /);
  });

  it("contains -- separator before the command", () => {
    const result = wrapCommandWithBwrap("ls /tmp", { default: "r--" }, HOME);
    expect(result).toContain("-- /bin/sh -c");
  });

  it("wraps command in /bin/sh -c", () => {
    const result = wrapCommandWithBwrap("cat /etc/hosts", { default: "r--" }, HOME);
    expect(result).toContain("/bin/sh -c");
    expect(result).toContain("cat /etc/hosts");
  });
});
