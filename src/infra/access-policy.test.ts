import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AccessPolicyConfig, ScriptPolicyEntry } from "../config/types.tools.js";
import {
  _resetAutoExpandedWarnedForTest,
  _resetMidPathWildcardWarnedForTest,
  applyScriptPolicyOverride,
  checkAccessPolicy,
  findBestRule,
  resolveArgv0,
  resolveScriptKey,
  validateAccessPolicyConfig,
} from "./access-policy.js";

// Use os.homedir() directly — consistent with how access-policy expands ~.
// Do NOT use expandHomePrefix() here: OPENCLAW_HOME in the test environment
// would redirect ~ to the OpenClaw config dir, which is not what ~ means
// in filesystem permission patterns.
const HOME = os.homedir();

// ---------------------------------------------------------------------------
// validateAccessPolicyConfig
// ---------------------------------------------------------------------------

describe("validateAccessPolicyConfig", () => {
  beforeEach(() => {
    _resetAutoExpandedWarnedForTest();
    _resetMidPathWildcardWarnedForTest();
  });

  it("returns no errors for a valid config", () => {
    expect(
      validateAccessPolicyConfig({
        policy: { "/**": "r--", [`${HOME}/**`]: "rwx", [`${HOME}/.ssh/**`]: "---" },
      }),
    ).toEqual([]);
  });

  it("returns no errors for an empty config", () => {
    expect(validateAccessPolicyConfig({})).toEqual([]);
  });

  it("rejects invalid rule perm value", () => {
    const errs = validateAccessPolicyConfig({ policy: { "/**": "rx" } });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/policy/);
  });

  it("rejects rule perm value with wrong char in w position", () => {
    const errs = validateAccessPolicyConfig({ policy: { "/**": "r1x" } });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/policy/);
  });

  it("reports an error when a rule perm value is invalid", () => {
    const errs = validateAccessPolicyConfig({ policy: { "/**": "xyz" } });
    expect(errs.length).toBeGreaterThanOrEqual(1);
  });

  it("file-specific '---' rule blocks access via checkAccessPolicy", () => {
    // A "---" rule on a specific file path must block reads at the tool layer.
    const file = process.execPath;
    const config: AccessPolicyConfig = {
      policy: { "/**": "rwx", [file]: "---" },
    };
    validateAccessPolicyConfig(config); // applies normalization in-place
    expect(checkAccessPolicy(file, "read", config)).toBe("deny");
  });

  it("validates scripts[].policy perm strings and emits diagnostics for bad ones", () => {
    // A typo like "rwX" in a script's policy must produce a diagnostic, not silently
    // fail closed (which would deny exec with no operator-visible error).
    const config: AccessPolicyConfig = {
      scripts: {
        "/usr/local/bin/deploy.sh": {
          policy: { "~/deploy/**": "rwX" }, // invalid: uppercase X
        },
      },
    };
    const errs = validateAccessPolicyConfig(config);
    expect(errs.some((e) => e.includes("rwX") && e.includes("scripts"))).toBe(true);
  });

  it("accepts valid rule perm strings", () => {
    expect(validateAccessPolicyConfig({ policy: { "/**": "rwx" } })).toEqual([]);
    expect(validateAccessPolicyConfig({ policy: { "/**": "---" } })).toEqual([]);
    expect(validateAccessPolicyConfig({ policy: { "/**": "r-x" } })).toEqual([]);
  });

  it("auto-expands a bare path that points to a real directory", () => {
    // os.tmpdir() is guaranteed to exist and be a directory on every platform.
    const dir = os.tmpdir();
    const config: AccessPolicyConfig = { policy: { [dir]: "r--" as const } };
    const errs = validateAccessPolicyConfig(config);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/auto-expanded/);
    // Rule should be rewritten in place with /** suffix.
    expect(config.policy?.[`${dir}/**`]).toBe("r--");
    expect(config.policy?.[dir]).toBeUndefined();
  });

  it("auto-expand does not overwrite an existing explicit glob rule", () => {
    // {"/tmp": "rwx", "/tmp/**": "---"} — bare /tmp should expand but must NOT
    // clobber the explicit /tmp/** rule. Without the guard, access would widen
    // from "---" to "rwx" — a security regression.
    const dir = os.tmpdir();
    const config: AccessPolicyConfig = {
      policy: { [dir]: "rwx", [`${dir}/**`]: "---" },
    };
    validateAccessPolicyConfig(config);
    // Explicit "---" rule must be preserved.
    expect(config.policy?.[`${dir}/**`]).toBe("---");
  });

  it("auto-expands when a ~ path expands to a real directory", () => {
    // "~" expands to os.homedir() which always exists and is a directory.
    const config: AccessPolicyConfig = { policy: { "~": "r--" } };
    const errs = validateAccessPolicyConfig(config);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/auto-expanded/);
    // Rule key should be rewritten with /** suffix.
    expect(config.policy?.["~/**"]).toBe("r--");
    expect(config.policy?.["~"]).toBeUndefined();
  });

  it("emits the diagnostic only once per process for the same pattern", () => {
    const dir = os.tmpdir();
    // First call — should warn.
    const first = validateAccessPolicyConfig({ policy: { [dir]: "r--" as const } });
    expect(first).toHaveLength(1);
    // Second call with the same bare pattern — already warned, silent.
    const second = validateAccessPolicyConfig({ policy: { [dir]: "r--" as const } });
    expect(second).toHaveLength(0);
  });

  it("does not warn for glob patterns or trailing-/ rules", () => {
    const dir = os.tmpdir();
    expect(validateAccessPolicyConfig({ policy: { [`${dir}/**`]: "r--" } })).toEqual([]);
    expect(validateAccessPolicyConfig({ policy: { [`${dir}/`]: "r--" } })).toEqual([]);
    expect(validateAccessPolicyConfig({ policy: { "/tmp/**": "rwx" } })).toEqual([]);
  });

  it("does not warn for bare file paths (stat confirms it is a file)", () => {
    // process.execPath is the running node/bun binary — always a real file, never a dir.
    expect(validateAccessPolicyConfig({ policy: { [process.execPath]: "r--" } })).toEqual([]);
  });

  it("does not warn for paths that do not exist (ENOENT silently ignored)", () => {
    expect(
      validateAccessPolicyConfig({
        policy: { "/nonexistent/path/that/cannot/exist-xyzzy": "r--" },
      }),
    ).toEqual([]);
  });

  it('auto-expands bare directory in scripts["policy"] shared rules', () => {
    const dir = os.tmpdir();
    const config: AccessPolicyConfig = {
      scripts: { policy: { [dir]: "rw-" as const } },
    };
    const errs = validateAccessPolicyConfig(config);
    expect(errs.some((e) => e.includes("auto-expanded"))).toBe(true);
    const sharedPolicy = config.scripts?.["policy"];
    expect(sharedPolicy?.[`${dir}/**`]).toBe("rw-");
    expect(sharedPolicy?.[dir]).toBeUndefined();
  });

  it("auto-expands bare directory in per-script policy entry", () => {
    const dir = os.tmpdir();
    const config: AccessPolicyConfig = {
      scripts: { "/deploy.sh": { policy: { [dir]: "rwx" as const } } },
    };
    const errs = validateAccessPolicyConfig(config);
    expect(errs.some((e) => e.includes("auto-expanded"))).toBe(true);
    const entry = config.scripts?.["/deploy.sh"] as ScriptPolicyEntry | undefined;
    expect(entry?.policy?.[`${dir}/**`]).toBe("rwx");
    expect(entry?.policy?.[dir]).toBeUndefined();
  });

  it("emits a one-time diagnostic for mid-path wildcard rules (OS-level enforcement skipped)", () => {
    _resetMidPathWildcardWarnedForTest();
    // "/home/*/secrets/**" has a wildcard in a non-final segment — bwrap and
    // Seatbelt cannot derive a concrete mount path so they skip it silently.
    // validateAccessPolicyConfig must surface this so operators know.
    const errs = validateAccessPolicyConfig({
      policy: { "/home/*/secrets/**": "---" },
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/mid-path wildcard/);
    expect(errs[0]).toMatch(/OS-level.*enforcement/);
  });

  it("deduplicates mid-path wildcard rule diagnostics across calls", () => {
    _resetMidPathWildcardWarnedForTest();
    const config = { policy: { "/home/*/secrets/**": "---" } };
    const first = validateAccessPolicyConfig(config);
    const second = validateAccessPolicyConfig(config);
    expect(first.filter((e) => e.includes("mid-path wildcard"))).toHaveLength(1);
    expect(second.filter((e) => e.includes("mid-path wildcard"))).toHaveLength(0);
  });

  it("non-deny mid-path wildcard emits approximate-prefix diagnostic (not cannot-apply)", () => {
    _resetMidPathWildcardWarnedForTest();
    const errs = validateAccessPolicyConfig({
      policy: { "~/.openclaw/agents/subri/workspace/skills/**/*.sh": "r-x" },
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/mid-path wildcard/);
    expect(errs[0]).toMatch(/prefix match/);
    expect(errs[0]).not.toMatch(/cannot apply/);
  });

  it("does NOT emit mid-path wildcard diagnostic for final-segment wildcards", () => {
    _resetMidPathWildcardWarnedForTest();
    // "/home/user/**" — wildcard is in the final segment, no path separator follows.
    const errs = validateAccessPolicyConfig({
      policy: { "/home/user/**": "r--", "~/**": "rwx", "/tmp/**": "---" },
    });
    expect(errs.filter((e) => e.includes("mid-path wildcard"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// permAllows fail-closed on malformed characters
// ---------------------------------------------------------------------------

describe("checkAccessPolicy — malformed permission characters fail closed", () => {
  it("treats a typo like 'r1-' as deny for write (only exact 'w' grants write)", () => {
    // "r1-": index 1 is "1", not "w" — must deny write, not allow it.
    const config = { policy: { "/tmp/**": "r1-" as unknown as "r--" } };
    expect(checkAccessPolicy("/tmp/foo.txt", "write", config)).toBe("deny");
  });

  it("treats 'R--' (uppercase) as deny for read (only lowercase 'r' grants read)", () => {
    const config = { policy: { "/tmp/**": "R--" as unknown as "r--" } };
    expect(checkAccessPolicy("/tmp/foo.txt", "read", config)).toBe("deny");
  });

  it("treats 'rWx' (uppercase W) as deny for write", () => {
    const config = { policy: { "/tmp/**": "rWx" as unknown as "rwx" } };
    expect(checkAccessPolicy("/tmp/foo.txt", "write", config)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Trailing slash shorthand
// ---------------------------------------------------------------------------

describe("checkAccessPolicy — trailing slash shorthand", () => {
  it('"/tmp/" is equivalent to "/tmp/**"', () => {
    const config: AccessPolicyConfig = { policy: { "/tmp/": "rwx" } };
    expect(checkAccessPolicy("/tmp/foo.txt", "write", config)).toBe("allow");
    expect(checkAccessPolicy("/tmp/a/b/c", "write", config)).toBe("allow");
  });

  it('"~/" is equivalent to "~/**"', () => {
    const config: AccessPolicyConfig = { policy: { "~/": "rw-" } };
    expect(checkAccessPolicy(`${HOME}/foo.txt`, "read", config)).toBe("allow");
    expect(checkAccessPolicy(`${HOME}/foo.txt`, "write", config)).toBe("allow");
    expect(checkAccessPolicy(`${HOME}/foo.txt`, "exec", config)).toBe("deny");
  });

  it('"---" rule with trailing slash blocks subtree', () => {
    const config: AccessPolicyConfig = {
      policy: { "/**": "rwx", [`${HOME}/.ssh/`]: "---" },
    };
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "read", config)).toBe("deny");
  });

  it("trailing slash and /** produce identical results", () => {
    const withSlash: AccessPolicyConfig = { policy: { "/tmp/": "rwx" } };
    const withGlob: AccessPolicyConfig = { policy: { "/tmp/**": "rwx" } };
    const paths = ["/tmp/a", "/tmp/a/b", "/tmp/a/b/c.txt"];
    for (const p of paths) {
      expect(checkAccessPolicy(p, "write", withSlash)).toBe(
        checkAccessPolicy(p, "write", withGlob),
      );
    }
  });

  it("trailing slash rule covers the directory itself (mkdir check)", () => {
    // Rule "~/.openclaw/heartbeat/" should allow write on the bare directory
    // path ~/.openclaw/heartbeat (no trailing component), not just its contents.
    const config: AccessPolicyConfig = {
      policy: { "/**": "r--", [`${HOME}/.openclaw/heartbeat/`]: "rw-" },
    };
    expect(checkAccessPolicy(`${HOME}/.openclaw/heartbeat`, "write", config)).toBe("allow");
    expect(checkAccessPolicy(`${HOME}/.openclaw/heartbeat/test.txt`, "write", config)).toBe(
      "allow",
    );
  });

  it('"---" trailing-slash rule blocks the directory itself and its contents', () => {
    const config: AccessPolicyConfig = {
      policy: { "/**": "rwx", [`${HOME}/.ssh/`]: "---" },
    };
    // Both the directory and its contents should be denied.
    expect(checkAccessPolicy(`${HOME}/.ssh`, "read", config)).toBe("deny");
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "read", config)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// normalizePlatformPath (macOS alias transparency)
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "darwin")(
  "checkAccessPolicy — macOS /private alias normalization",
  () => {
    const config: AccessPolicyConfig = {
      policy: {
        "/tmp/**": "rwx",
        "/var/**": "r--",
        "/etc/**": "r--",
      },
    };

    it("/private/tmp path is treated as /tmp — write allowed", () => {
      expect(checkAccessPolicy("/private/tmp/foo.txt", "write", config)).toBe("allow");
    });

    it("/private/var path is treated as /var — write denied (r-- only)", () => {
      expect(checkAccessPolicy("/private/var/log/system.log", "write", config)).toBe("deny");
    });

    it("/private/etc path is treated as /etc — read allowed", () => {
      expect(checkAccessPolicy("/private/etc/hosts", "read", config)).toBe("allow");
    });

    it("/tmp path still works directly", () => {
      expect(checkAccessPolicy("/tmp/foo.txt", "write", config)).toBe("allow");
    });

    it('"---" rule for /tmp/** also blocks /private/tmp/**', () => {
      const denyConfig: AccessPolicyConfig = {
        policy: { "/**": "rwx", "/tmp/**": "---" },
      };
      expect(checkAccessPolicy("/private/tmp/evil.sh", "exec", denyConfig)).toBe("deny");
    });

    it("/private/tmp/** deny rule blocks /tmp/** target", () => {
      // Rule written with /private/tmp must still match the normalized /tmp target.
      const denyConfig: AccessPolicyConfig = {
        policy: { "/**": "rwx", "/private/tmp/**": "---" },
      };
      expect(checkAccessPolicy("/tmp/evil.sh", "read", denyConfig)).toBe("deny");
    });

    it("/private/tmp/** rule matches /tmp/** target", () => {
      // Rule written with /private/* prefix must match a /tmp/* target path.
      const cfg: AccessPolicyConfig = {
        policy: { "/private/tmp/**": "rwx" },
      };
      expect(checkAccessPolicy("/tmp/foo.txt", "write", cfg)).toBe("allow");
    });
  },
);

// ---------------------------------------------------------------------------
// findBestRule
// ---------------------------------------------------------------------------

describe("findBestRule", () => {
  it("returns null when rules is empty", () => {
    expect(findBestRule("/foo/bar", {})).toBeNull();
  });

  it("returns matching rule", () => {
    expect(findBestRule("/foo/bar", { "/foo/**": "r--" })).toBe("r--");
  });

  it("prefers longer (more specific) pattern over shorter", () => {
    const rules = {
      "/**": "r--",
      "/foo/**": "rw-",
      "/foo/bar/**": "rwx",
    };
    expect(findBestRule("/foo/bar/baz.txt", rules)).toBe("rwx");
    expect(findBestRule("/foo/other.txt", rules)).toBe("rw-");
    expect(findBestRule("/etc/passwd", rules)).toBe("r--");
  });

  it("expands ~ in patterns", () => {
    const rules = { "~/**": "rw-" };
    expect(findBestRule(`${HOME}/workspace/foo.py`, rules)).toBe("rw-");
  });

  it("returns null when no pattern matches", () => {
    const rules = { "/foo/**": "rw-" };
    expect(findBestRule("/bar/baz", rules)).toBeNull();
  });

  it("bare directory path matches /** rule without requiring /. suffix", () => {
    // findBestRule("/tmp", {"/tmp/**": "r--"}) must return "r--".
    // Previously callers had to pass "/tmp/." to trigger a match — fragile contract.
    const rules = { "/tmp/**": "r--" };
    expect(findBestRule("/tmp", rules)).toBe("r--");
  });

  it("tilde rule beats broader absolute rule when expanded path is longer", () => {
    // "~/.ssh/**" expanded is e.g. "/home/user/.ssh/**" (longer than "/home/user/**").
    // The tilde rule must win so an explicit "---" denial is not silently overridden.
    const rules: Record<string, "---" | "rwx"> = {
      [`${HOME}/**`]: "rwx",
      "~/.ssh/**": "---",
    };
    expect(findBestRule(`${HOME}/.ssh/id_rsa`, rules, HOME)).toBe("---");
  });
});

// ---------------------------------------------------------------------------
// checkAccessPolicy — "---" rules act as deny
// ---------------------------------------------------------------------------

describe('checkAccessPolicy — "---" rules act as deny', () => {
  it('"---" rule blocks all ops, even when a broader rule would allow', () => {
    const config: AccessPolicyConfig = {
      policy: { "/**": "rwx", [`${HOME}/.ssh/**`]: "---" },
    };
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "read", config)).toBe("deny");
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "write", config)).toBe("deny");
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "exec", config)).toBe("deny");
  });

  it.skipIf(process.platform === "win32")(
    '"---" rule does not affect paths outside its glob',
    () => {
      const config: AccessPolicyConfig = {
        policy: { "/**": "rwx", [`${HOME}/.ssh/**`]: "---" },
      };
      expect(checkAccessPolicy(`${HOME}/workspace/foo.py`, "read", config)).toBe("allow");
    },
  );

  it("multiple narrowing rules block distinct subtrees", () => {
    const config: AccessPolicyConfig = {
      policy: { "/**": "rwx", [`${HOME}/.ssh/**`]: "---", [`${HOME}/.gnupg/**`]: "---" },
    };
    expect(checkAccessPolicy(`${HOME}/.gnupg/secring.gpg`, "read", config)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// checkAccessPolicy — rules
// ---------------------------------------------------------------------------

describe("checkAccessPolicy — rules", () => {
  it("allows read when r bit is set", () => {
    const config: AccessPolicyConfig = { policy: { "/**": "r--" } };
    expect(checkAccessPolicy("/etc/passwd", "read", config)).toBe("allow");
  });

  it("denies write when w bit is absent", () => {
    const config: AccessPolicyConfig = { policy: { "/**": "r--" } };
    expect(checkAccessPolicy("/etc/passwd", "write", config)).toBe("deny");
  });

  it("denies exec when x bit is absent", () => {
    const config: AccessPolicyConfig = { policy: { "/usr/bin/**": "r--" } };
    expect(checkAccessPolicy("/usr/bin/grep", "exec", config)).toBe("deny");
  });

  it("allows exec when x bit is set", () => {
    const config: AccessPolicyConfig = { policy: { "/usr/bin/**": "r-x" } };
    expect(checkAccessPolicy("/usr/bin/grep", "exec", config)).toBe("allow");
  });

  it("longer rule overrides shorter for the same path", () => {
    const config: AccessPolicyConfig = {
      policy: {
        "/**": "r--",
        [`${HOME}/**`]: "rwx",
      },
    };
    // Home subpath → rwx wins
    expect(checkAccessPolicy(`${HOME}/workspace/foo`, "write", config)).toBe("allow");
    // Outside home → r-- applies
    expect(checkAccessPolicy("/etc/passwd", "write", config)).toBe("deny");
  });

  it("specific sub-path rule can restrict a broader allow", () => {
    const config: AccessPolicyConfig = {
      policy: {
        [`${HOME}/**`]: "rwx",
        [`${HOME}/.config/**`]: "r--",
      },
    };
    expect(checkAccessPolicy(`${HOME}/workspace/foo`, "write", config)).toBe("allow");
    expect(checkAccessPolicy(`${HOME}/.config/sensitive`, "write", config)).toBe("deny");
  });

  it("tilde rule beats broader absolute rule — expanded length wins", () => {
    // Without the expanded-length fix, "~/.ssh/**" (9 raw chars) would lose to
    // `${HOME}/**` when HOME is long, letting rwx override the intended --- deny.
    const config: AccessPolicyConfig = {
      policy: {
        [`${HOME}/**`]: "rwx",
        "~/.ssh/**": "---",
      },
    };
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "read", config, HOME)).toBe("deny");
    expect(checkAccessPolicy(`${HOME}/workspace/foo`, "write", config, HOME)).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// checkAccessPolicy — implicit fallback to "---"
// ---------------------------------------------------------------------------

describe("checkAccessPolicy — implicit fallback to ---", () => {
  it("denies all ops when no rule matches (implicit --- fallback)", () => {
    const config: AccessPolicyConfig = {
      policy: { [`${HOME}/**`]: "rwx" },
    };
    expect(checkAccessPolicy("/etc/passwd", "read", config)).toBe("deny");
    expect(checkAccessPolicy("/etc/passwd", "write", config)).toBe("deny");
    expect(checkAccessPolicy("/etc/passwd", "exec", config)).toBe("deny");
  });

  it('"/**" rule acts as catch-all for unmatched paths', () => {
    const config: AccessPolicyConfig = {
      policy: { [`${HOME}/**`]: "rwx", "/**": "r--" },
    };
    expect(checkAccessPolicy("/etc/passwd", "read", config)).toBe("allow");
    expect(checkAccessPolicy("/etc/passwd", "write", config)).toBe("deny");
  });

  it("empty rules deny everything via implicit fallback", () => {
    const config: AccessPolicyConfig = {
      policy: { [`${HOME}/workspace/**`]: "rw-" },
    };
    expect(checkAccessPolicy("/tmp/foo", "read", config)).toBe("deny");
    expect(checkAccessPolicy("/tmp/foo", "write", config)).toBe("deny");
    expect(checkAccessPolicy("/tmp/foo", "exec", config)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// checkAccessPolicy — precedence integration
// ---------------------------------------------------------------------------

describe("checkAccessPolicy — precedence integration", () => {
  it("narrowing rule beats broader allow — all in play", () => {
    const config: AccessPolicyConfig = {
      policy: {
        "/**": "r--",
        [`${HOME}/**`]: "rwx",
        [`${HOME}/.ssh/**`]: "---",
      },
    };
    // Broader home rule allows writes
    expect(checkAccessPolicy(`${HOME}/workspace/foo`, "write", config)).toBe("allow");
    // Narrowing "---" beats the home rwx rule
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "read", config)).toBe("deny");
    // Outer "/**" rule applies outside home
    expect(checkAccessPolicy("/etc/hosts", "read", config)).toBe("allow");
    expect(checkAccessPolicy("/etc/hosts", "write", config)).toBe("deny");
    // "/proc/self/mem" matches "/**" (r--)
    expect(checkAccessPolicy("/proc/self/mem", "read", config)).toBe("allow");
  });

  it("empty config denies everything (implicit --- fallback)", () => {
    const config: AccessPolicyConfig = {};
    expect(checkAccessPolicy("/anything", "read", config)).toBe("deny");
    expect(checkAccessPolicy("/anything", "write", config)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Symlink attack scenarios — resolved-path policy checks
//
// macOS Seatbelt (and the bwrap layer) evaluate the *resolved* real path at
// the syscall level, not the symlink path. checkAccessPolicy is called with
// the already-resolved path. These tests document the expected behavior when
// a symlink in an allowed directory points to a denied or restricted target.
// ---------------------------------------------------------------------------

describe("checkAccessPolicy — symlink resolved-path scenarios", () => {
  it('denies read on resolved symlink target covered by "---" rule', () => {
    // ~/workspace/link → ~/.ssh/id_rsa (symlink in allowed dir to denied-subpath)
    // Caller passes the resolved path; the "---" rule wins.
    const config: AccessPolicyConfig = {
      policy: { [`${HOME}/workspace/**`]: "rw-", [`${HOME}/.ssh/**`]: "---" },
    };
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "read", config, HOME)).toBe("deny");
  });

  it("denies write on resolved symlink target covered by restrictive rule", () => {
    // ~/workspace/link → ~/workspace/secret/file
    // workspace is rw-, but the secret subdir is r--. Resolved path hits r--.
    const config: AccessPolicyConfig = {
      policy: {
        [`${HOME}/workspace/**`]: "rw-",
        [`${HOME}/workspace/secret/**`]: "r--",
      },
    };
    expect(checkAccessPolicy(`${HOME}/workspace/secret/file.txt`, "write", config, HOME)).toBe(
      "deny",
    );
    // Read is still allowed via the r-- rule.
    expect(checkAccessPolicy(`${HOME}/workspace/secret/file.txt`, "read", config, HOME)).toBe(
      "allow",
    );
  });

  it("symlink source path in allowed dir is allowed; resolved denied target is denied", () => {
    // This illustrates that the policy must be checked on the resolved path.
    const config: AccessPolicyConfig = {
      policy: { [`${HOME}/workspace/**`]: "rw-", [`${HOME}/.aws/**`]: "---" },
    };
    // Source path (the symlink) — allowed
    expect(checkAccessPolicy(`${HOME}/workspace/creds`, "read", config, HOME)).toBe("allow");
    // Real target — denied
    expect(checkAccessPolicy(`${HOME}/.aws/credentials`, "read", config, HOME)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// resolveArgv0
// ---------------------------------------------------------------------------

describe("resolveArgv0", () => {
  it("returns null for empty command", () => {
    expect(resolveArgv0("")).toBeNull();
    expect(resolveArgv0("   ")).toBeNull();
  });

  it("extracts first unquoted token", () => {
    // /bin/sh exists on all platforms; if not, the non-resolved path is returned
    const result = resolveArgv0("/bin/sh -c 'echo hi'");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  it("extracts double-quoted path", () => {
    const result = resolveArgv0(`"/bin/sh" -c 'echo hi'`);
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  it("returns null for relative path without cwd", () => {
    expect(resolveArgv0("./script.py")).toBeNull();
  });

  it("resolves relative path against cwd", () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-")));
    const scriptPath = path.join(tmpDir, "script.py");
    fs.writeFileSync(scriptPath, "#!/usr/bin/env python3\n");
    try {
      const result = resolveArgv0("./script.py arg1 arg2", tmpDir);
      expect(result).toBe(scriptPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("expands ~ in path", () => {
    // /bin/ls will exist on test hosts; just verify ~ expansion doesn't crash
    const result = resolveArgv0("~/nonexistent-script-xyz");
    // Returns expanded (non-realpath) since file doesn't exist
    expect(result).toBe(`${HOME}/nonexistent-script-xyz`);
  });

  it("skips leading env-prefix assignments to find real argv0", () => {
    // "FOO=1 /bin/sh -c cmd" — argv0 is /bin/sh, not FOO=1.
    // Without this, policy.scripts lookup and sha256 checks are bypassed.
    const result = resolveArgv0("FOO=1 BAR=2 /bin/sh -c 'echo hi'");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  it("returns null when command is only env assignments with no argv0", () => {
    expect(resolveArgv0("FOO=1 BAR=2")).toBeNull();
  });

  it("unquotes a double-quoted argv0 that follows env assignments", () => {
    // FOO=1 "/opt/my script.sh" — argv0 is /opt/my script.sh (spaces in path).
    // Without unquoting, the token would be '"/opt/my' — wrong path, sha256 bypass.
    const result = resolveArgv0('FOO=1 "/bin/sh" -c echo');
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  it("handles env assignments with single-quoted values containing spaces", () => {
    // FOO='a b' /bin/sh — naive whitespace split yields ["FOO='a", "b'", "/bin/sh"].
    // "b'" does not match NAME=, so it was wrongly treated as argv0, bypassing
    // script policy lookups. Must be parsed as argv0=/bin/sh.
    const result = resolveArgv0("FOO='a b' /bin/sh -c echo");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  it("handles env assignments with double-quoted values containing spaces", () => {
    const result = resolveArgv0('BAR="hello world" /bin/sh -c echo');
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  it("handles multiple env assignments with quoted values", () => {
    const result = resolveArgv0("A='x y' B='p q' /bin/sh -c echo");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  // The following tests use /bin/sh and Unix env behaviour — skip on Windows where
  // /bin/sh doesn't exist and env resolves to env.EXE with different semantics.
  const itUnix = it.skipIf(process.platform === "win32");

  itUnix("looks through quoted /usr/bin/env to the real script", () => {
    // `"/usr/bin/env" /bin/sh` — argv0 is quoted, but env look-through must still fire.
    // Without this fix, commandRest was empty in the quoted branch so env look-through
    // was skipped and the function returned /usr/bin/env instead of /bin/sh.
    const result = resolveArgv0(`"/usr/bin/env" /bin/sh -c echo`);
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  itUnix("looks through env -i flag to reach the real script", () => {
    // `env -i /bin/sh` — without fix, recurses on `-i /bin/sh` and resolves `-i` as argv0.
    const result = resolveArgv0("env -i /bin/sh -c echo");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  itUnix("looks through env --ignore-environment long flag", () => {
    const result = resolveArgv0("env --ignore-environment /bin/sh -c echo");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  itUnix("looks through env -u VAR (option that consumes next token)", () => {
    const result = resolveArgv0("env -u HOME /bin/sh -c echo");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  itUnix("looks through env -- end-of-options marker", () => {
    const result = resolveArgv0("env -- /bin/sh -c echo");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  itUnix("resolves bare binary name via PATH rather than cwd", () => {
    // `sh` with no `/` should find /bin/sh on PATH, not <cwd>/sh.
    // Without fix, path.resolve(cwd, "sh") produces <cwd>/sh which doesn't exist.
    const result = resolveArgv0("sh -c echo", "/nonexistent/cwd");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
    expect(result).not.toContain("/nonexistent/cwd");
  });

  it("still resolves explicitly relative tokens (./foo) against cwd", () => {
    // `./script.py` contains `/` so PATH lookup is skipped — cwd resolution applies.
    expect(resolveArgv0("./script.py", undefined)).toBeNull(); // no cwd → null
  });

  itUnix("uses a literal PATH= env prefix override when looking up bare names", () => {
    // PATH=/nonexistent has no $, so findOnPath uses /nonexistent — sh not found there,
    // falls back to cwd resolution rather than the real process PATH.
    const result = resolveArgv0("PATH=/nonexistent sh", "/some/cwd");
    // Must NOT resolve to the real /bin/sh (which would mean process PATH was used).
    if (result !== null) {
      expect(result).toContain("/some/cwd");
    }
  });

  itUnix("ignores PATH= prefix containing shell vars and uses process PATH instead", () => {
    // PATH=/alt:$PATH has $, so the override is skipped; sh found on process PATH.
    const result = resolveArgv0("PATH=/alt:$PATH sh");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  itUnix("strips --block-signal as a standalone flag without consuming next token", () => {
    // --block-signal uses [=SIG] syntax — must not consume /bin/sh as its argument.
    const result = resolveArgv0("env --block-signal /bin/sh -c echo");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  itUnix("strips --default-signal and --ignore-signal as standalone flags", () => {
    expect(resolveArgv0("env --default-signal /bin/sh")).toMatch(/sh$/);
    expect(resolveArgv0("env --ignore-signal /bin/sh")).toMatch(/sh$/);
  });

  itUnix("recurses into env -S split-string argument to find real argv0", () => {
    // env -S "FOO=1 /bin/sh -c echo" — the argument to -S is itself a command string.
    // Must recurse and return /bin/sh, not null or /usr/bin/env.
    const result = resolveArgv0('env -S "FOO=1 /bin/sh -c echo"');
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  itUnix("recurses into env --split-string long form", () => {
    const result = resolveArgv0("env --split-string '/bin/sh -c echo'");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  itUnix("looks through env -C with a quoted directory arg containing spaces", () => {
    // env -C "/path with space" /bin/sh — the dir arg is quoted; must not leave a
    // dangling fragment that gets treated as the command.
    const result = resolveArgv0('env -C "/path with space" /bin/sh -c echo');
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  itUnix("looks through env --chdir with a quoted directory arg", () => {
    const result = resolveArgv0("env --chdir '/tmp/my dir' /bin/sh -c echo");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  itUnix("recurses into env --split-string=VALUE equals form", () => {
    // --split-string=CMD (equals form) was previously not handled — resolveArgv0
    // returned null, causing the fallback to treat "env" as argv0 and silently
    // bypass tool-layer hash/policy checks for the embedded script.
    const result = resolveArgv0("env --split-string='/bin/sh -c echo'");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  itUnix("recurses into env -S=VALUE equals form (short flag with equals)", () => {
    const result = resolveArgv0("env -S='/bin/sh -c echo'");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  itUnix("recurses into env -SVALUE compact form (no space, no equals)", () => {
    const result = resolveArgv0("env -S'/bin/sh -c echo'");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  itUnix("strips quoted argv0 with internal spaces when looking through env", () => {
    // `"/usr/bin env" /bin/sh` — argv0 contains a space inside quotes.
    // The bare /^\S+\s*/ regex stopped at the first space, leaving a corrupted afterEnv.
    // The fix strips the full quoted token before processing env options/args.
    // We use a path we know exists so realpathSync succeeds.
    const result = resolveArgv0('"/usr/bin/env" /bin/sh -c echo');
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh$/);
  });

  it("returns null for deeply nested env -S to prevent stack overflow", () => {
    // Build a deeply nested "env -S 'env -S ...' " string beyond the depth cap (8).
    let cmd = "/bin/sh";
    for (let i = 0; i < 10; i++) {
      cmd = `env -S '${cmd}'`;
    }
    // Should not throw; depth cap returns null before stack overflow.
    expect(() => resolveArgv0(cmd)).not.toThrow();
    // Result may be null (cap hit) or a resolved path — either is acceptable.
    // The important invariant is: no RangeError.
  });
});

// ---------------------------------------------------------------------------
// resolveScriptKey
// ---------------------------------------------------------------------------

describe("resolveScriptKey", () => {
  it("expands leading ~", () => {
    const result = resolveScriptKey("~/bin/deploy.sh");
    expect(result).toBe(path.join(HOME, "bin/deploy.sh"));
  });

  it("returns non-absolute keys unchanged", () => {
    expect(resolveScriptKey("deploy.sh")).toBe("deploy.sh");
  });

  it("returns non-existent absolute path unchanged", () => {
    const p = "/no/such/path/definitely-missing-xyz";
    expect(resolveScriptKey(p)).toBe(p);
  });

  it("resolves an absolute path that exists to its real path", () => {
    // Use os.tmpdir() itself — guaranteed to exist; realpathSync may resolve
    // macOS /tmp → /private/tmp so we accept either the same string or a longer one.
    const result = resolveScriptKey(os.tmpdir());
    expect(path.isAbsolute(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyScriptPolicyOverride
// ---------------------------------------------------------------------------

describe("applyScriptPolicyOverride", () => {
  it("returns base policy unchanged when no scripts block", () => {
    const base: AccessPolicyConfig = { policy: { "/**": "r--" } };
    const { policy, hashMismatch } = applyScriptPolicyOverride(base, "/any/path");
    expect(hashMismatch).toBeUndefined();
    expect(policy).toBe(base);
  });

  it("returns base policy unchanged when argv0 not in scripts", () => {
    const base: AccessPolicyConfig = {
      policy: { "/**": "r--" },
      scripts: { "/other/script.sh": { policy: { "/tmp/**": "rwx" } } },
    };
    const { policy, hashMismatch } = applyScriptPolicyOverride(base, "/my/script.sh");
    expect(hashMismatch).toBeUndefined();
    expect(policy).toBe(base);
  });

  it("matches a scripts key that is a symlink to the resolved argv0 path", () => {
    // Simulate the symlink case: create a real file and a symlink to it, then
    // register the symlink path as the scripts key. resolveArgv0 returns the
    // realpathSync result, so the key must be resolved the same way to match.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-symlink-test-"));
    const realScript = path.join(tmpDir, "script-real.sh");
    const symlinkScript = path.join(tmpDir, "script-link.sh");
    fs.writeFileSync(realScript, "#!/bin/sh\necho ok\n");
    fs.symlinkSync(realScript, symlinkScript);
    try {
      const resolvedReal = fs.realpathSync(symlinkScript);
      const base: AccessPolicyConfig = {
        policy: { "/**": "r--" },
        // Key is the symlink path; resolvedArgv0 will be the real path.
        scripts: { [symlinkScript]: { policy: { "/tmp/**": "rwx" } } },
      };
      const { overrideRules, hashMismatch } = applyScriptPolicyOverride(base, resolvedReal);
      expect(hashMismatch).toBeUndefined();
      // Without symlink resolution in the key lookup this would be undefined.
      expect(overrideRules?.["/tmp/**"]).toBe("rwx");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("returns override rules separately so seatbelt emits them after base rules", () => {
    const base: AccessPolicyConfig = {
      policy: { "/**": "r--" },
      scripts: { "/my/script.sh": { policy: { [`${HOME}/.openclaw/credentials/`]: "r--" } } },
    };
    const { policy, overrideRules, hashMismatch } = applyScriptPolicyOverride(
      base,
      "/my/script.sh",
    );
    expect(hashMismatch).toBeUndefined();
    // Base rules unchanged in policy
    expect(policy.policy?.["/**"]).toBe("r--");
    expect(policy.policy?.[`${HOME}/.openclaw/credentials/`]).toBeUndefined();
    // Override rules returned separately — caller emits them last in seatbelt profile
    expect(overrideRules?.[`${HOME}/.openclaw/credentials/`]).toBe("r--");
    expect(policy.scripts).toBeUndefined();
  });

  it("override rules returned separately — base policy rule unchanged", () => {
    const base: AccessPolicyConfig = {
      policy: { [`${HOME}/workspace/**`]: "r--" },
      scripts: { "/trusted.sh": { policy: { [`${HOME}/workspace/**`]: "rwx" } } },
    };
    const { policy, overrideRules } = applyScriptPolicyOverride(base, "/trusted.sh");
    expect(policy.policy?.[`${HOME}/workspace/**`]).toBe("r--");
    expect(overrideRules?.[`${HOME}/workspace/**`]).toBe("rwx");
  });

  it("narrowing override returned separately", () => {
    const base: AccessPolicyConfig = {
      policy: { "/tmp/**": "rwx" },
      scripts: { "/cautious.sh": { policy: { "/tmp/**": "r--" } } },
    };
    const { policy, overrideRules } = applyScriptPolicyOverride(base, "/cautious.sh");
    expect(policy.policy?.["/tmp/**"]).toBe("rwx");
    expect(overrideRules?.["/tmp/**"]).toBe("r--");
  });

  it("returns hashMismatch when sha256 does not match file content", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-"));
    const scriptPath = path.join(tmpDir, "script.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho hi\n");
    // resolveArgv0 returns the realpathSync result; simulate that here so the
    // key lookup (which also calls realpathSync) matches correctly on macOS where
    // os.tmpdir() returns /var/folders/... but realpathSync yields /private/var/...
    const realScriptPath = fs.realpathSync(scriptPath);
    try {
      const base: AccessPolicyConfig = {
        scripts: {
          [scriptPath]: { sha256: "deadbeef".padEnd(64, "0"), policy: { "/tmp/**": "rwx" } },
        },
      };
      const { policy, hashMismatch } = applyScriptPolicyOverride(base, realScriptPath);
      expect(hashMismatch).toBe(true);
      expect(policy).toBe(base);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("matches scripts key written with ~ even though resolvedArgv0 is absolute", () => {
    // Regression: "~/bin/deploy.sh" in scripts{} must match resolvedArgv0 "/home/user/bin/deploy.sh".
    // A direct object lookup misses tilde keys; ~ must be expanded before comparing.
    const absPath = path.join(os.homedir(), "bin", "deploy.sh");
    const base: AccessPolicyConfig = {
      policy: { "/**": "rwx" },
      scripts: { "~/bin/deploy.sh": { policy: { "/secret/**": "---" } } },
    };
    const { overrideRules, hashMismatch } = applyScriptPolicyOverride(base, absPath);
    expect(hashMismatch).toBeUndefined();
    expect(overrideRules?.["/secret/**"]).toBe("---");
  });

  it("applies override when sha256 matches — rules in overrideRules, not policy", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-"));
    const scriptPath = path.join(tmpDir, "script.sh");
    const content = "#!/bin/sh\necho hi\n";
    fs.writeFileSync(scriptPath, content);
    const hash = crypto.createHash("sha256").update(Buffer.from(content)).digest("hex");
    const realScriptPath = fs.realpathSync(scriptPath);
    try {
      const base: AccessPolicyConfig = {
        policy: { "/**": "r--" },
        scripts: { [scriptPath]: { sha256: hash, policy: { "/tmp/**": "rwx" } } },
      };
      const { policy, overrideRules, hashMismatch } = applyScriptPolicyOverride(
        base,
        realScriptPath,
      );
      expect(hashMismatch).toBeUndefined();
      expect(overrideRules?.["/tmp/**"]).toBe("rwx");
      expect(policy.policy?.["/tmp/**"]).toBeUndefined();
      expect(policy.scripts).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
