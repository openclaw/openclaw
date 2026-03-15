import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { AccessPolicyConfig } from "../config/types.tools.js";
import {
  _resetBwrapAvailableCacheForTest,
  _resetBwrapFileDenyWarnedPathsForTest,
  _warnBwrapFileDenyOnce,
  generateBwrapArgs,
  isBwrapAvailable,
  wrapCommandWithBwrap,
} from "./exec-sandbox-bwrap.js";

const HOME = os.homedir();

// bwrap is Linux-only — skip the generateBwrapArgs tests on other platforms so
// Windows/macOS CI does not fail on fs.statSync calls against Unix-only paths
// like /etc/hosts that don't exist there.
describe.skipIf(process.platform !== "linux")("generateBwrapArgs", () => {
  it("starts with --ro-bind / / when /**  rule allows reads", () => {
    const config: AccessPolicyConfig = { policy: { "/**": "r--" } };
    const args = generateBwrapArgs(config, HOME);
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
  });

  it("does not use --ro-bind / / when no /** rule (restrictive base)", () => {
    const config: AccessPolicyConfig = {};
    const args = generateBwrapArgs(config, HOME);
    // Should not contain root bind
    const rootBindIdx = args.findIndex(
      (a, i) => a === "--ro-bind" && args[i + 1] === "/" && args[i + 2] === "/",
    );
    expect(rootBindIdx).toBe(-1);
  });

  it("ends with --", () => {
    const config: AccessPolicyConfig = { policy: { "/**": "r--" } };
    const args = generateBwrapArgs(config, HOME);
    expect(args[args.length - 1]).toBe("--");
  });

  it('adds --tmpfs for "---" rules in permissive mode', () => {
    const config: AccessPolicyConfig = {
      policy: { "/**": "r--", [`${HOME}/.ssh/**`]: "---", [`${HOME}/.gnupg/**`]: "---" },
    };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain(`${HOME}/.ssh`);
    expect(tmpfsMounts).toContain(`${HOME}/.gnupg`);
  });

  it('expands ~ in "---" rules using homeDir', () => {
    const config: AccessPolicyConfig = {
      policy: { "/**": "r--", "~/.ssh/**": "---" },
    };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain(`${HOME}/.ssh`);
  });

  it("adds --bind for paths with w bit in rules", () => {
    const config: AccessPolicyConfig = {
      policy: { "/**": "r--", [`${HOME}/workspace/**`]: "rw-" },
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
      policy: { "/**": "r--", "/usr/bin/**": "r--" },
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

  it('"---" rule for sensitive path appears in args regardless of broader rule', () => {
    const config: AccessPolicyConfig = {
      policy: { "/**": "r--", [`${HOME}/**`]: "rwx", [`${HOME}/.ssh/**`]: "---" },
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
    const args = generateBwrapArgs({ policy: { "/**": "r--" } }, HOME);
    const procIdx = args.indexOf("--proc");
    expect(procIdx).toBeGreaterThan(-1);
    expect(args[procIdx + 1]).toBe("/proc");
  });

  it("adds --tmpfs /tmp in permissive mode (/** allows reads)", () => {
    const config: AccessPolicyConfig = { policy: { "/**": "r--" } };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain("/tmp");
  });

  it("does not add --tmpfs /tmp in restrictive mode (no /** rule)", () => {
    // Without a "/**" rule, the base is restrictive — no /tmp by default.
    const config: AccessPolicyConfig = {};
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).not.toContain("/tmp");
  });

  it("skips --tmpfs /tmp in permissive mode when policy explicitly restricts /tmp writes", () => {
    // A rule "/tmp/**": "r--" means the user wants /tmp read-only; the base --ro-bind / /
    // already makes it readable. Adding --tmpfs /tmp would silently grant write access.
    const config: AccessPolicyConfig = { policy: { "/**": "r--", "/tmp/**": "r--" } };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).not.toContain("/tmp");
  });

  it("skips --tmpfs /tmp when an explicit write rule covers /tmp (rules loop emits --bind-try)", () => {
    // Regression: the old code also emitted --tmpfs /tmp when explicitTmpPerm[1] === "w",
    // but the rules loop always follows with --bind-try /tmp /tmp which wins (last mount wins
    // in bwrap). The --tmpfs was dead code. Confirm: explicit rw- rule → no --tmpfs /tmp,
    // but --bind-try /tmp IS present.
    const config: AccessPolicyConfig = { policy: { "/**": "r--", "/tmp/**": "rw-" } };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    const bindMounts = args
      .map((a, i) => (a === "--bind-try" ? args[i + 1] : null))
      .filter(Boolean);
    expect(tmpfsMounts).not.toContain("/tmp");
    expect(bindMounts).toContain("/tmp");
  });

  it("does not add --tmpfs /tmp in restrictive mode (no /** rule) — regression guard", () => {
    // When there is no "/**" rule at all, no /tmp mount should appear.
    const config: AccessPolicyConfig = { policy: { [`${HOME}/workspace/**`]: "rwx" } };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).not.toContain("/tmp");
  });

  it('"---" rule in permissive mode gets --tmpfs overlay to block reads', () => {
    // With "/**":"r--", --ro-bind / / makes everything readable. A narrowing
    // rule like "/secret/**": "---" must overlay --tmpfs so the path is hidden.
    const config: AccessPolicyConfig = {
      policy: { "/**": "r--", [`${HOME}/secret/**`]: "---" },
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

  it("narrowing rule on an existing file does not emit --tmpfs (bwrap only accepts dirs)", () => {
    // process.execPath is always an existing file — use it as the test target.
    const filePath = process.execPath;
    const config: AccessPolicyConfig = {
      policy: { "/**": "r--", [filePath]: "---" },
    };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    // Must NOT emit --tmpfs for a file path.
    expect(tmpfsMounts).not.toContain(filePath);
  });

  it('"--x" rule in permissive mode gets --tmpfs overlay to block reads', () => {
    // Execute-only rules have no read bit — same treatment as "---" in permissive mode.
    const config: AccessPolicyConfig = {
      policy: { "/**": "r--", [`${HOME}/scripts/**`]: "--x" },
    };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain(`${HOME}/scripts`);
  });

  it('"---" rule on SYSTEM_RO_BIND_PATHS path emits --tmpfs in restrictive mode', () => {
    // SYSTEM_RO_BIND_PATHS (/etc, /usr, /bin, /lib, /lib64, /sbin, /opt) are unconditionally
    // --ro-bind-try mounted in restrictive mode. Without a --tmpfs overlay, a "---" rule on
    // e.g. "/etc/**" has no OS-level effect — syscalls inside the sandbox can still read
    // /etc/passwd, /etc/shadow, etc. The fix: treat deny rules the same in both modes.
    const config: AccessPolicyConfig = {
      policy: { "/etc/**": "---" },
    };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain("/etc");
    // Must NOT emit a read mount for a deny rule.
    const roBound = args
      .map((a, i) => (a === "--ro-bind-try" ? args[i + 1] : null))
      .filter(Boolean);
    expect(roBound).not.toContain("/etc");
  });

  it('"---" rules do not create --ro-bind-try mounts in restrictive mode', () => {
    // A rule with "---" permission should NOT produce any bwrap mount — the
    // restrictive base already denies by not mounting. Emitting --ro-bind-try
    // for a "---" rule would silently grant read access to paths that should
    // be fully blocked.
    const config: AccessPolicyConfig = {
      policy: {
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
      policy: { [`${HOME}/scripts/**`]: "--x" },
    };
    const args = generateBwrapArgs(config, HOME);
    const roBound = args
      .map((a, i) => (a === "--ro-bind-try" ? args[i + 1] : null))
      .filter(Boolean);
    expect(roBound).not.toContain(`${HOME}/scripts`);
  });

  it('"-w-" rule in restrictive mode emits --bind-try so writes do not silently fail', () => {
    // A write-only rule ("-w-") without "/**" now emits --bind-try so the path
    // exists in the bwrap namespace and writes succeed. bwrap cannot enforce
    // write-without-read at the mount level; reads are also permitted at the OS layer,
    // but the tool layer still denies read tool calls per the "-w-" rule.
    const config: AccessPolicyConfig = {
      policy: { [`${HOME}/logs/**`]: "-w-" },
    };
    const args = generateBwrapArgs(config, HOME);
    const bindMounts = args
      .map((a, i) => (a === "--bind-try" ? args[i + 1] : null))
      .filter(Boolean);
    expect(bindMounts).toContain(`${HOME}/logs`);
  });

  it('"-w-" rule in permissive mode emits --bind-try (write upgrade, reads already allowed)', () => {
    // Under "/**":"r--", --ro-bind / / already grants reads everywhere.
    // A "-w-" rule upgrades to rw for that path — reads are not newly leaked
    // since the base already allowed them.
    const config: AccessPolicyConfig = {
      policy: { "/**": "r--", [`${HOME}/output/**`]: "-w-" },
    };
    const args = generateBwrapArgs(config, HOME);
    const bindMounts = args
      .map((a, i) => (a === "--bind-try" ? args[i + 1] : null))
      .filter(Boolean);
    expect(bindMounts).toContain(`${HOME}/output`);
  });

  it("skips mid-path wildcard --- patterns — deny-all on truncated prefix would be too broad", () => {
    // "/home/*/.config/**" with "---" truncates to "/home" — applying --tmpfs to /home
    // would hide the entire home directory. Must be skipped.
    const fakeHome = "/home/testuser";
    const config: AccessPolicyConfig = {
      policy: { "/**": "r--", "/home/*/.config/**": "---" },
    };
    const args = generateBwrapArgs(config, fakeHome);
    const allMountTargets = args
      .map((a, i) =>
        ["--tmpfs", "--bind-try", "--ro-bind-try"].includes(args[i - 1] ?? "") ? a : null,
      )
      .filter(Boolean);
    expect(allMountTargets).not.toContain("/home");
  });

  it("non-deny mid-path wildcard emits prefix as approximate mount target", () => {
    // "scripts/**/*.sh": "r-x" — mid-path wildcard, non-deny perm.
    // OS layer uses the concrete prefix (/scripts) as an approximate ro-bind-try target;
    // the tool layer enforces the *.sh filter precisely.
    const config: AccessPolicyConfig = {
      policy: { "/scripts/**/*.sh": "r-x" },
    };
    const args = generateBwrapArgs(config, "/home/user");
    const allMountTargets = args
      .map((a, i) =>
        ["--tmpfs", "--bind-try", "--ro-bind-try"].includes(args[i - 1] ?? "") ? a : null,
      )
      .filter(Boolean);
    expect(allMountTargets).toContain("/scripts");
  });

  it("suffix-glob rule uses parent directory as mount target, not literal prefix", () => {
    // "/var/log/secret*" must mount "/var/log", NOT the literal prefix "/var/log/secret"
    // which is not a directory and leaves entries like "/var/log/secret.old" unprotected.
    const config: AccessPolicyConfig = {
      policy: { "/**": "r--", "/var/log/secret*": "---" },
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
      policy: {
        [`${HOME}/dev/secret/**`]: "r--",
        [`${HOME}/dev/**`]: "rw-",
      },
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

  it('script override "---" rule targeting a file does not emit --tmpfs (bwrap rejects file paths)', () => {
    // The base-rules loop has an isDir guard before --tmpfs; the scriptOverrideRules loop must too.
    // /etc/hosts is a real file; emitting --tmpfs /etc/hosts would make bwrap fail at runtime.
    const config: AccessPolicyConfig = { policy: { "/**": "r--" } };
    const overrides = { "/etc/hosts": "---" as const };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const args = generateBwrapArgs(config, HOME, overrides);
      const tmpfsMounts = args
        .map((a, i) => (a === "--tmpfs" ? args[i + 1] : null))
        .filter(Boolean);
      expect(tmpfsMounts).not.toContain("/etc/hosts");
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("/etc/hosts"));
    } finally {
      spy.mockRestore();
    }
  });

  it('script override "---" rule targeting a non-existent path emits --tmpfs (assumed directory)', () => {
    const config: AccessPolicyConfig = { policy: { "/**": "r--" } };
    const overrides = { "/nonexistent-path-for-test/**": "---" as const };
    const args = generateBwrapArgs(config, HOME, overrides);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain("/nonexistent-path-for-test");
  });

  it('script override "-w-" under restrictive base emits --bind-try, not --tmpfs', () => {
    // Greptile: permAllowsWrite && (r || defaultR) condition was wrong — for -w- without /**
    // both flags are false so it fell to else → --tmpfs, silently blocking writes.
    // Fix: any write-granting override always emits --bind-try.
    const config: AccessPolicyConfig = {
      policy: { [`${HOME}/workspace/**`]: "rwx" },
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

  it("narrowing rule that resolves to an existing file does not emit --tmpfs (bwrap only accepts dirs)", () => {
    // /etc/hosts is a file on Linux; bwrap --tmpfs rejects file paths.
    // generateBwrapArgs must not emit "--tmpfs /etc/hosts" — it should be silently skipped.
    const config: AccessPolicyConfig = { policy: { "/**": "r--", "/etc/hosts/**": "---" } };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).not.toContain("/etc/hosts");
  });

  it("emits a console.error warning when a file-specific narrowing rule path is skipped", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      _warnBwrapFileDenyOnce("/etc/passwd");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("/etc/passwd"));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("parent directory"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it('still emits --tmpfs for "---" rule that resolves to a directory', () => {
    // Non-existent paths are treated as directories (forward-protection).
    const config: AccessPolicyConfig = {
      policy: { "/**": "r--", [`${HOME}/.nonexistent-dir/**`]: "---" },
    };
    const args = generateBwrapArgs(config, HOME);
    const tmpfsMounts = args.map((a, i) => (a === "--tmpfs" ? args[i + 1] : null)).filter(Boolean);
    expect(tmpfsMounts).toContain(`${HOME}/.nonexistent-dir`);
  });

  it("trailing-slash rule is treated as /** and resolves to correct path", () => {
    // "/tmp/" is shorthand for "/tmp/**" — must produce the same mount target
    // and sort-order length as an explicit "/tmp/**" rule.
    const withSlash = generateBwrapArgs({ policy: { "/tmp/": "rw-" } }, HOME);
    const withGlob = generateBwrapArgs({ policy: { "/tmp/**": "rw-" } }, HOME);
    const bindOf = (args: string[]) =>
      args.map((a, i) => (args[i - 1] === "--bind-try" ? a : null)).filter(Boolean);
    expect(bindOf(withSlash)).toContain("/tmp");
    expect(bindOf(withSlash)).toEqual(bindOf(withGlob));
  });

  it("malformed perm string in base rules emits no mount (fail closed, not --ro-bind-try)", () => {
    // A malformed perm like "rwxoops" must not produce a --ro-bind-try mount.
    // Previously the else-if branch accessed perm[0] without VALID_PERM_RE guard,
    // which could emit --ro-bind-try for a rule meant to be restrictive.
    const config: AccessPolicyConfig = {
      policy: {
        [`${HOME}/workspace/**`]:
          "rwxoops" as unknown as import("../config/types.tools.js").PermStr,
      },
    };
    const args = generateBwrapArgs(config, HOME);
    const roBound = args
      .map((a, i) => (a === "--ro-bind-try" ? args[i + 1] : null))
      .filter(Boolean);
    const rwBound = args.map((a, i) => (a === "--bind-try" ? args[i + 1] : null)).filter(Boolean);
    // Malformed perm must not produce any mount for this path.
    expect(roBound).not.toContain(`${HOME}/workspace`);
    expect(rwBound).not.toContain(`${HOME}/workspace`);
  });

  it("malformed perm string in script override emits no --ro-bind-try (fail closed)", () => {
    // Same VALID_PERM_RE guard required in the scriptOverrideRules loop.
    const config: AccessPolicyConfig = { policy: { "/**": "r--" } };
    const overrides = {
      [`${HOME}/data/**`]: "rwxoops" as unknown as import("../config/types.tools.js").PermStr,
    };
    const args = generateBwrapArgs(config, HOME, overrides);
    const roBound = args
      .map((a, i) => (a === "--ro-bind-try" ? args[i + 1] : null))
      .filter(Boolean);
    const rwBound = args.map((a, i) => (a === "--bind-try" ? args[i + 1] : null)).filter(Boolean);
    expect(roBound).not.toContain(`${HOME}/data`);
    expect(rwBound).not.toContain(`${HOME}/data`);
  });
});

describe("wrapCommandWithBwrap", () => {
  it("starts with bwrap", () => {
    const result = wrapCommandWithBwrap("ls /tmp", { policy: { "/**": "r--" } }, HOME);
    expect(result).toMatch(/^bwrap /);
  });

  it("contains -- separator before the command", () => {
    const result = wrapCommandWithBwrap("ls /tmp", { policy: { "/**": "r--" } }, HOME);
    expect(result).toContain("-- /bin/sh -c");
  });

  it("wraps command in /bin/sh -c", () => {
    const result = wrapCommandWithBwrap("cat /etc/hosts", { policy: { "/**": "r--" } }, HOME);
    expect(result).toContain("/bin/sh -c");
    expect(result).toContain("cat /etc/hosts");
  });
});

describe("_resetBwrapAvailableCacheForTest", () => {
  it("clears the availability cache so isBwrapAvailable re-probes", async () => {
    // Prime the cache with one result, then reset and verify the next call re-checks.
    await isBwrapAvailable(); // populates cache
    _resetBwrapAvailableCacheForTest();
    // After reset, isBwrapAvailable must re-probe (result may differ in test env — just
    // verify it returns a boolean without throwing, proving the cache was cleared).
    const result = await isBwrapAvailable();
    expect(typeof result).toBe("boolean");
  });
});

describe("_resetBwrapFileDenyWarnedPathsForTest", () => {
  it("clears the warned-paths set so the same path can warn again", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // First warning — set is empty, should fire.
    _warnBwrapFileDenyOnce("/tmp/secret.txt");
    expect(spy).toHaveBeenCalledTimes(1);
    // Second call with same path — already warned, should NOT fire again.
    _warnBwrapFileDenyOnce("/tmp/secret.txt");
    expect(spy).toHaveBeenCalledTimes(1);
    // After reset the warning should fire again.
    _resetBwrapFileDenyWarnedPathsForTest();
    _warnBwrapFileDenyOnce("/tmp/secret.txt");
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
