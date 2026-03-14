import os from "node:os";
import { describe, expect, it } from "vitest";

// Seatbelt (SBPL) path handling uses Unix forward-slash semantics.
// Tests that assert specific HOME paths in the profile are skipped on Windows
// where os.homedir() returns backslash paths that the generator does not emit.
const skipOnWindows = it.skipIf(process.platform === "win32");
import type { AccessPolicyConfig } from "../config/types.tools.js";
import { generateSeatbeltProfile, wrapCommandWithSeatbelt } from "./exec-sandbox-seatbelt.js";

const HOME = os.homedir();

describe("generateSeatbeltProfile", () => {
  it("starts with (version 1)", () => {
    const profile = generateSeatbeltProfile({}, HOME);
    expect(profile).toMatch(/^\(version 1\)/);
  });

  it("uses (deny default) when no /**  catch-all rule", () => {
    const profile = generateSeatbeltProfile({}, HOME);
    expect(profile).toContain("(deny default)");
    expect(profile).not.toContain("(allow default)");
  });

  it("uses (allow default) when /** rule has any permission", () => {
    const profile = generateSeatbeltProfile({ rules: { "/**": "r--" } }, HOME);
    expect(profile).toContain("(allow default)");
    expect(profile).not.toContain("(deny default)");
  });

  it("includes system baseline reads when no catch-all rule", () => {
    const profile = generateSeatbeltProfile({}, HOME);
    expect(profile).toContain("(allow file-read*");
    expect(profile).toContain("/usr/lib");
    expect(profile).toContain("/System/Library");
  });

  skipOnWindows("--- rule emits deny file-read*, file-write*, process-exec* for that path", () => {
    const config: AccessPolicyConfig = {
      rules: { "/**": "rwx", [`${HOME}/.ssh/**`]: "---" },
    };
    const profile = generateSeatbeltProfile(config, HOME);
    expect(profile).toContain(`(deny file-read*`);
    expect(profile).toContain(`(deny file-write*`);
    expect(profile).toContain(`(deny process-exec*`);
    expect(profile).toContain(HOME + "/.ssh");
  });

  skipOnWindows("expands ~ in --- rules using provided homeDir", () => {
    const config: AccessPolicyConfig = {
      rules: { "/**": "rwx", "~/.ssh/**": "---" },
    };
    const profile = generateSeatbeltProfile(config, HOME);
    expect(profile).toContain(HOME + "/.ssh");
    expect(profile).not.toContain("~/.ssh");
  });

  skipOnWindows("expands ~ in rules using provided homeDir", () => {
    const config: AccessPolicyConfig = {
      rules: { "~/**": "rw-" },
    };
    const profile = generateSeatbeltProfile(config, HOME);
    expect(profile).toContain(HOME);
  });

  it("rw- rule emits allow read+write, deny exec for that path", () => {
    const config: AccessPolicyConfig = {
      rules: { [`${HOME}/workspace/**`]: "rw-" },
    };
    const profile = generateSeatbeltProfile(config, HOME);
    expect(profile).toContain(`(allow file-read*`);
    expect(profile).toContain(`(allow file-write*`);
    expect(profile).toContain(`(deny process-exec*`);
  });

  it("r-x rule emits allow read+exec, deny write for that path", () => {
    const config: AccessPolicyConfig = {
      rules: { "/usr/bin/**": "r-x" },
    };
    const profile = generateSeatbeltProfile(config, HOME);
    const rulesSection = profile.split("; User-defined path rules")[1] ?? "";
    expect(rulesSection).toContain("(allow file-read*");
    expect(rulesSection).toContain("(allow process-exec*");
    expect(rulesSection).toContain("(deny file-write*");
  });

  it("narrowing --- rule appears after broader allow rule in profile", () => {
    // SBPL last-match-wins: the --- rule for .ssh must appear after the broader rwx rule.
    const config: AccessPolicyConfig = {
      rules: { [`${HOME}/**`]: "rwx", [`${HOME}/.ssh/**`]: "---" },
    };
    const profile = generateSeatbeltProfile(config, HOME);
    const rulesIdx = profile.indexOf("; User-defined path rules");
    expect(rulesIdx).toBeGreaterThan(-1);
    // The broader allow must appear before the narrowing deny.
    const allowIdx = profile.indexOf("(allow file-read*");
    const denyIdx = profile.lastIndexOf("(deny file-read*");
    expect(allowIdx).toBeGreaterThan(-1);
    expect(denyIdx).toBeGreaterThan(allowIdx);
  });

  it("handles empty config without throwing", () => {
    expect(() => generateSeatbeltProfile({}, HOME)).not.toThrow();
  });

  it("permissive base with no exec bit includes system baseline exec paths", () => {
    // "/**": "r--" emits (deny process-exec* (subpath "/")) but must also allow
    // system binaries — otherwise ls, grep, cat all fail inside the sandbox.
    const profile = generateSeatbeltProfile({ rules: { "/**": "r--" } }, HOME);
    expect(profile).toContain("(allow process-exec*");
    expect(profile).toContain("/bin");
    expect(profile).toContain("/usr/bin");
  });

  it("permissive base with exec bit does NOT add redundant exec baseline", () => {
    // "/**": "rwx" already allows everything including exec — no extra baseline needed.
    const profile = generateSeatbeltProfile({ rules: { "/**": "rwx" } }, HOME);
    expect(profile).toContain("(allow default)");
    expect(profile).not.toContain("System baseline exec");
  });

  skipOnWindows("script-override narrowing emits deny ops so access is actually reduced", () => {
    // Base allows rw- on workspace; script override narrows to r-- for a subpath.
    // Without deny ops in the override block, write would still be allowed.
    const config: AccessPolicyConfig = {
      rules: { [`${HOME}/workspace/**`]: "rw-" },
    };
    const overrideRules: Record<string, string> = { [`${HOME}/workspace/locked/**`]: "r--" };
    const profile = generateSeatbeltProfile(config, HOME, overrideRules);
    // The override section must deny write for the locked path.
    const overrideSection = profile.split("Script-override")[1] ?? "";
    expect(overrideSection).toContain("(deny file-write*");
    expect(overrideSection).toContain(`${HOME}/workspace/locked`);
  });

  it("omits /private/tmp baseline when no rule grants /tmp", () => {
    const profile = generateSeatbeltProfile({}, HOME);
    expect(profile).not.toContain(`(subpath "/private/tmp")`);
  });

  it("includes /private/tmp baseline when a rule grants read access to /tmp", () => {
    const profile = generateSeatbeltProfile({ rules: { "/tmp/**": "rw-" } }, HOME);
    expect(profile).toContain(`(subpath "/private/tmp")`);
  });

  it("read-only /tmp rule does not grant file-write* on /private/tmp", () => {
    const profile = generateSeatbeltProfile({ rules: { "/tmp/**": "r--" } }, HOME);
    expect(profile).toMatch(/allow file-read[^)]*\(subpath "\/private\/tmp"\)/);
    expect(profile).not.toMatch(/allow file-write\*[^)]*\(subpath "\/private\/tmp"\)/);
  });

  it("write-only /tmp rule grants file-write* but not read ops on /private/tmp", () => {
    const profile = generateSeatbeltProfile({ rules: { "/tmp/**": "-w-" } }, HOME);
    expect(profile).toMatch(/allow file-write\*[^)]*\(subpath "\/private\/tmp"\)/);
    expect(profile).not.toMatch(/allow file-read[^)]*\(subpath "\/private\/tmp"\)/);
  });

  it("exec-only /tmp rule grants process-exec* on /private/tmp", () => {
    const profile = generateSeatbeltProfile({ rules: { "/tmp/**": "--x" } }, HOME);
    expect(profile).toMatch(/allow process-exec\*[^)]*\(subpath "\/private\/tmp"\)/);
    expect(profile).not.toMatch(/allow file-read[^)]*\(subpath "\/private\/tmp"\)/);
    expect(profile).not.toMatch(/allow file-write\*[^)]*\(subpath "\/private\/tmp"\)/);
  });

  it("r-x /tmp rule grants both read and exec on /private/tmp", () => {
    const profile = generateSeatbeltProfile({ rules: { "/tmp/**": "r-x" } }, HOME);
    expect(profile).toMatch(/allow file-read[^)]*\(subpath "\/private\/tmp"\)/);
    expect(profile).toMatch(/allow process-exec\*[^)]*\(subpath "\/private\/tmp"\)/);
    expect(profile).not.toMatch(/allow file-write\*[^)]*\(subpath "\/private\/tmp"\)/);
  });

  // ---------------------------------------------------------------------------
  // Symlink attack mitigation — profile ordering
  //
  // macOS Seatbelt evaluates the *resolved* (real) path at syscall time, not
  // the symlink path. So a symlink in an allowed directory pointing to a denied
  // target is blocked by the deny rule for the real path — but only if that
  // deny rule appears AFTER the allow rule for the workspace in the profile
  // (SBPL: last matching rule wins).
  // ---------------------------------------------------------------------------

  skipOnWindows(
    "--- rule for sensitive path appears after workspace allow — symlink to deny target is blocked",
    () => {
      // If ~/workspace/link → ~/.ssh/id_rsa, seatbelt evaluates ~/.ssh/id_rsa.
      // The --- rule for ~/.ssh must appear after the workspace allow so it wins.
      const config: AccessPolicyConfig = {
        rules: {
          [`${HOME}/workspace/**`]: "rw-",
          [`${HOME}/.ssh/**`]: "---",
        },
      };
      const profile = generateSeatbeltProfile(config, HOME);
      const workspaceAllowIdx = profile.indexOf("(allow file-read*");
      const sshDenyIdx = profile.lastIndexOf("(deny file-read*");
      expect(workspaceAllowIdx).toBeGreaterThan(-1);
      expect(sshDenyIdx).toBeGreaterThan(workspaceAllowIdx);
      expect(profile).toContain(`${HOME}/.ssh`);
      expect(profile).toContain(`${HOME}/workspace`);
    },
  );

  skipOnWindows(
    "restrictive rule on subdir appears after broader rw rule — covers symlink to restricted subtree",
    () => {
      const config: AccessPolicyConfig = {
        rules: {
          [`${HOME}/workspace/**`]: "rw-",
          [`${HOME}/workspace/secret/**`]: "r--",
        },
      };
      const profile = generateSeatbeltProfile(config, HOME);
      const workspaceWriteIdx = profile.indexOf("(allow file-write*");
      const secretWriteDenyIdx = profile.lastIndexOf("(deny file-write*");
      expect(workspaceWriteIdx).toBeGreaterThan(-1);
      expect(secretWriteDenyIdx).toBeGreaterThan(workspaceWriteIdx);
      expect(profile).toContain(`${HOME}/workspace/secret`);
    },
  );

  it("glob patterns are stripped to their longest concrete prefix", () => {
    const config: AccessPolicyConfig = {
      rules: { "/Users/kaveri/.ssh/**": "---", "/**": "rwx" },
    };
    const profile = generateSeatbeltProfile(config, "/Users/kaveri");
    expect(profile).not.toContain("**");
    expect(profile).toContain("/Users/kaveri/.ssh");
  });
});

describe("wrapCommandWithSeatbelt", () => {
  it("wraps command with sandbox-exec -f <tmpfile>", () => {
    const result = wrapCommandWithSeatbelt("ls /tmp", "(version 1)\n(allow default)");
    expect(result).toMatch(/^sandbox-exec -f /);
    expect(result).toContain("ls /tmp");
    // Profile content is in a temp file, not inline — not visible in ps output.
    expect(result).not.toContain("(version 1)");
  });

  it("profile file is not embedded in the command string", () => {
    const result = wrapCommandWithSeatbelt("echo hi", "(allow default) ; it's a test");
    expect(result).not.toContain("it's a test");
    expect(result).toContain("openclaw-sb-");
  });

  it("uses a distinct profile file per call to avoid concurrent-exec policy races", () => {
    const r1 = wrapCommandWithSeatbelt("echo 1", "(allow default)");
    const r2 = wrapCommandWithSeatbelt("echo 2", "(allow default)");
    // Each call must get its own file so overlapping execs with different profiles don't race.
    const extract = (cmd: string) => cmd.match(/-f (\S+)/)?.[1];
    expect(extract(r1)).not.toBe(extract(r2));
    expect(extract(r1)).toContain("openclaw-sb-");
    expect(extract(r2)).toContain("openclaw-sb-");
  });

  it("wraps command in /bin/sh -c", () => {
    const result = wrapCommandWithSeatbelt("cat /etc/hosts", "(allow default)");
    expect(result).toContain("/bin/sh -c");
  });

  it("profile file path contains a random component (not just pid+seq)", () => {
    const extract = (cmd: string) => cmd.match(/-f (\S+)/)?.[1] ?? "";
    const r1 = wrapCommandWithSeatbelt("echo 1", "(allow default)");
    const r2 = wrapCommandWithSeatbelt("echo 2", "(allow default)");
    // Path must be unpredictable — strip the pid prefix and check the random suffix varies.
    const suffix = (p: string) => p.replace(/.*openclaw-sb-\d+-/, "").replace(".sb", "");
    expect(suffix(extract(r1))).not.toBe(suffix(extract(r2)));
    expect(suffix(extract(r1)).length).toBeGreaterThanOrEqual(8); // at least 4 random bytes
  });
});

describe("generateSeatbeltProfile — mid-path wildcard guard", () => {
  skipOnWindows(
    "non-deny mid-path wildcard emits prefix subpath for r/w but NOT exec (option B)",
    () => {
      // skills/**/*.sh: r-x — mid-path wildcard; OS prefix is /home.
      // Read is emitted (bounded over-grant). Exec is omitted — granting exec on the
      // entire prefix would allow arbitrary binaries to run, not just *.sh files.
      // Exec falls through to ancestor rule; tool layer enforces it precisely.
      const profile = generateSeatbeltProfile({ rules: { "/home/*/workspace/**": "r-x" } }, HOME);
      const rulesSection = profile.split("; User-defined path rules")[1] ?? "";
      expect(rulesSection).toContain("(allow file-read*");
      expect(rulesSection).toContain('(subpath "/home")');
      expect(rulesSection).not.toContain("(allow process-exec*");
      // exec deny also omitted — falls through to ancestor
      expect(rulesSection).not.toContain("(deny process-exec*");
    },
  );

  skipOnWindows("--- mid-path wildcard is skipped (deny-all on prefix would be too broad)", () => {
    // A deny-all on the /home prefix would block the entire home directory — too broad.
    const profile = generateSeatbeltProfile({ rules: { "/home/*/workspace/**": "---" } }, HOME);
    expect(profile).not.toContain('(subpath "/home")');
  });

  skipOnWindows("still emits trailing-** rules that have no mid-path wildcard", () => {
    const profile = generateSeatbeltProfile({ rules: { "/tmp/**": "rwx" } }, HOME);
    expect(profile).toContain('(subpath "/tmp")');
  });

  skipOnWindows("? wildcard is stripped correctly — no literal ? in SBPL matcher", () => {
    // Pattern "/tmp/file?.txt" has a ? wildcard; the strip regex must remove it so
    // the SBPL matcher does not contain a raw "?" character. Stripping "?.txt" from
    // "/tmp/file?.txt" yields "/tmp/file" — a more precise subpath than "/tmp".
    const profile = generateSeatbeltProfile({ rules: { "/tmp/file?.txt": "r--" } }, HOME);
    expect(profile).not.toMatch(/\?/); // no literal ? in the emitted profile
    expect(profile).toContain('(subpath "/tmp/file")');
  });
});
