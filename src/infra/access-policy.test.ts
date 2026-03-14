import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AccessPolicyConfig } from "../config/types.tools.js";
import {
  _resetAutoExpandedWarnedForTest,
  _resetMidPathWildcardWarnedForTest,
  applyScriptPolicyOverride,
  checkAccessPolicy,
  findBestRule,
  resolveArgv0,
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
        rules: { "/**": "r--", [`${HOME}/**`]: "rwx" },
        deny: [`${HOME}/.ssh/**`],
        default: "---",
      }),
    ).toEqual([]);
  });

  it("returns no errors for an empty config", () => {
    expect(validateAccessPolicyConfig({})).toEqual([]);
  });

  it("rejects invalid default perm string — too short", () => {
    const errs = validateAccessPolicyConfig({ default: "rw" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/default/);
  });

  it("rejects invalid default perm string — too long", () => {
    const errs = validateAccessPolicyConfig({ default: "rwxr" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/default/);
  });

  it("rejects invalid default perm string — wrong chars", () => {
    const errs = validateAccessPolicyConfig({ default: "rq-" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/default/);
  });

  it("rejects invalid rule perm value", () => {
    const errs = validateAccessPolicyConfig({ rules: { "/**": "rx" } });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/rules/);
  });

  it("rejects rule perm value with wrong char in w position", () => {
    const errs = validateAccessPolicyConfig({ rules: { "/**": "r1x" } });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/rules/);
  });

  it("reports multiple errors when both default and a rule are invalid", () => {
    const errs = validateAccessPolicyConfig({
      default: "bad",
      rules: { "/**": "xyz" },
    });
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects empty deny entry", () => {
    const errs = validateAccessPolicyConfig({ deny: [""] });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/deny/);
  });

  it("auto-expands a bare directory path in deny[] to /**", () => {
    const dir = os.tmpdir();
    const config: AccessPolicyConfig = { deny: [dir] };
    const errs = validateAccessPolicyConfig(config);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/auto-expanded/);
    expect(config.deny?.[0]).toBe(`${dir}/**`);
  });

  it("auto-expands bare deny[] entry even when the directory does not yet exist", () => {
    // Non-existent paths are treated as future directories and expanded to /**.
    const nonExistent = path.join(os.tmpdir(), "openclaw-test-nonexistent-" + Date.now());
    const config: AccessPolicyConfig = { deny: [nonExistent] };
    const errs = validateAccessPolicyConfig(config);
    expect(config.deny?.[0]).toBe(`${nonExistent}/**`);
    expect(errs[0]).toMatch(/auto-expanded/);
  });

  it("auto-expands non-existent versioned directory names (v1.0, app-2.3) in deny[]", () => {
    // Versioned names like "v1.0" or "pkg-1.0.0" look like files via naive dot-detection
    // but are almost always directories. The tightened heuristic requires the extension
    // to contain at least one letter — digits-only extensions (like ".0") are treated as
    // directory-like and expanded to /**.
    const base = os.tmpdir();
    const versionedDir = path.join(base, `openclaw-test-v1.0-${Date.now()}`);
    const config: AccessPolicyConfig = { deny: [versionedDir] };
    validateAccessPolicyConfig(config);
    expect(config.deny?.[0]).toBe(`${versionedDir}/**`); // must be expanded
  });

  it("does NOT auto-expand a non-existent deny[] path that looks like a file (has extension)", () => {
    // "~/future-secrets.key" doesn't exist yet but the extension heuristic should
    // prevent expansion to "~/future-secrets.key/**" — the user intends to protect
    // the file itself, not a subtree of non-existent children.
    const fileLikePath = path.join(os.tmpdir(), `openclaw-test-${Date.now()}.key`);
    const config: AccessPolicyConfig = { deny: [fileLikePath] };
    validateAccessPolicyConfig(config);
    expect(config.deny?.[0]).toBe(fileLikePath); // must NOT be expanded to /**
  });

  it("auto-expands non-existent bare dotnames (.ssh, .aws, .env) to /** — treats as future directory", () => {
    // Bare dotnames without a secondary extension (.ssh, .aws, .env, .gnupg) cannot be
    // reliably identified as file vs. directory before they exist. The safe choice is to
    // expand to /** so the subtree is protected if a directory is created there.
    // When the path later exists as a file, statSync confirms it and the bare pattern is kept.
    const base = os.tmpdir();
    for (const name of [".ssh", ".aws", ".env", ".netrc", ".gnupg", ".config"]) {
      _resetAutoExpandedWarnedForTest();
      const p = path.join(base, name);
      const config: AccessPolicyConfig = { deny: [p] };
      validateAccessPolicyConfig(config);
      expect(config.deny?.[0]).toBe(`${p}/**`); // expanded to protect subtree
    }
  });

  it("does NOT auto-expand a bare deny[] entry that is an existing file", () => {
    // A specific file like "~/.ssh/id_rsa" must stay as an exact-match pattern.
    // Expanding it to "~/.ssh/id_rsa/**" would only match non-existent children,
    // leaving the file itself unprotected at the tool layer and in bwrap.
    // process.execPath is the running node/bun binary — always a real file.
    const file = process.execPath;
    const config: AccessPolicyConfig = { deny: [file] };
    validateAccessPolicyConfig(config);
    expect(config.deny?.[0]).toBe(file); // kept as bare path, not expanded
  });

  it("file-specific deny[] entry blocks access to the file via checkAccessPolicy", () => {
    // Regression: bare file path in deny[] must block reads at the tool layer.
    const file = process.execPath;
    const config: AccessPolicyConfig = { default: "rwx", deny: [file] };
    validateAccessPolicyConfig(config); // applies normalization in-place
    expect(checkAccessPolicy(file, "read", config)).toBe("deny");
  });

  it("validates scripts[].rules perm strings and emits diagnostics for bad ones", () => {
    // A typo like "rwX" in a script's rules must produce a diagnostic, not silently
    // fail closed (which would deny exec with no operator-visible error).
    const config: AccessPolicyConfig = {
      scripts: {
        "/usr/local/bin/deploy.sh": {
          rules: { "~/deploy/**": "rwX" }, // invalid: uppercase X
        },
      },
    };
    const errs = validateAccessPolicyConfig(config);
    expect(errs.some((e) => e.includes("rwX") && e.includes("scripts"))).toBe(true);
  });

  it("validates scripts[].deny entries and emits diagnostics for empty patterns", () => {
    const config: AccessPolicyConfig = {
      scripts: {
        "/usr/local/bin/deploy.sh": {
          deny: ["", "~/.secrets/**"], // first entry is invalid empty string
        },
      },
    };
    const errs = validateAccessPolicyConfig(config);
    expect(errs.some((e) => e.includes("scripts") && e.includes("deny"))).toBe(true);
  });

  it("accepts valid 'rwx' and '---' perm strings", () => {
    expect(validateAccessPolicyConfig({ default: "rwx" })).toEqual([]);
    expect(validateAccessPolicyConfig({ default: "---" })).toEqual([]);
    expect(validateAccessPolicyConfig({ default: "r-x" })).toEqual([]);
  });

  it("auto-expands a bare path that points to a real directory", () => {
    // os.tmpdir() is guaranteed to exist and be a directory on every platform.
    const dir = os.tmpdir();
    const config = { rules: { [dir]: "r--" as const } };
    const errs = validateAccessPolicyConfig(config);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/auto-expanded/);
    // Rule should be rewritten in place with /** suffix.
    expect(config.rules[`${dir}/**`]).toBe("r--");
    expect(config.rules[dir]).toBeUndefined();
  });

  it("auto-expand does not overwrite an existing explicit glob rule", () => {
    // {"/tmp": "rwx", "/tmp/**": "---"} — bare /tmp should expand but must NOT
    // clobber the explicit /tmp/** rule. Without the guard, access would widen
    // from "---" to "rwx" — a security regression.
    const dir = os.tmpdir();
    const config: AccessPolicyConfig = {
      rules: { [dir]: "rwx", [`${dir}/**`]: "---" },
    };
    validateAccessPolicyConfig(config);
    // Explicit "---" rule must be preserved.
    expect(config.rules?.[`${dir}/**`]).toBe("---");
  });

  it("auto-expands when a ~ path expands to a real directory", () => {
    // "~" expands to os.homedir() which always exists and is a directory.
    const config: AccessPolicyConfig = { rules: { "~": "r--" } };
    const errs = validateAccessPolicyConfig(config);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/auto-expanded/);
    // Rule key should be rewritten with /** suffix.
    expect(config.rules?.["~/**"]).toBe("r--");
    expect(config.rules?.["~"]).toBeUndefined();
  });

  it("emits the diagnostic only once per process for the same pattern", () => {
    const dir = os.tmpdir();
    // First call — should warn.
    const first = validateAccessPolicyConfig({ rules: { [dir]: "r--" as const } });
    expect(first).toHaveLength(1);
    // Second call with the same bare pattern — already warned, silent.
    const second = validateAccessPolicyConfig({ rules: { [dir]: "r--" as const } });
    expect(second).toHaveLength(0);
  });

  it("does not warn for glob patterns or trailing-/ rules", () => {
    const dir = os.tmpdir();
    expect(validateAccessPolicyConfig({ rules: { [`${dir}/**`]: "r--" } })).toEqual([]);
    expect(validateAccessPolicyConfig({ rules: { [`${dir}/`]: "r--" } })).toEqual([]);
    expect(validateAccessPolicyConfig({ rules: { "/tmp/**": "rwx" } })).toEqual([]);
  });

  it("does not warn for bare file paths (stat confirms it is a file)", () => {
    // process.execPath is the running node/bun binary — always a real file, never a dir.
    expect(validateAccessPolicyConfig({ rules: { [process.execPath]: "r--" } })).toEqual([]);
  });

  it("does not warn for paths that do not exist (ENOENT silently ignored)", () => {
    expect(
      validateAccessPolicyConfig({
        rules: { "/nonexistent/path/that/cannot/exist-xyzzy": "r--" },
      }),
    ).toEqual([]);
  });

  it("emits a one-time diagnostic for mid-path wildcard rules (OS-level enforcement skipped)", () => {
    _resetMidPathWildcardWarnedForTest();
    // "/home/*/secrets/**" has a wildcard in a non-final segment — bwrap and
    // Seatbelt cannot derive a concrete mount path so they skip it silently.
    // validateAccessPolicyConfig must surface this so operators know.
    const errs = validateAccessPolicyConfig({
      rules: { "/home/*/secrets/**": "---" },
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/mid-path wildcard/);
    expect(errs[0]).toMatch(/OS-level.*enforcement/);
  });

  it("deduplicates mid-path wildcard rule diagnostics across calls", () => {
    _resetMidPathWildcardWarnedForTest();
    const config = { rules: { "/home/*/secrets/**": "---" } };
    const first = validateAccessPolicyConfig(config);
    const second = validateAccessPolicyConfig(config);
    expect(first.filter((e) => e.includes("mid-path wildcard"))).toHaveLength(1);
    expect(second.filter((e) => e.includes("mid-path wildcard"))).toHaveLength(0);
  });

  it("emits a one-time diagnostic for mid-path wildcard deny[] entries", () => {
    _resetMidPathWildcardWarnedForTest();
    const errs = validateAccessPolicyConfig({
      deny: ["/tmp/*/sensitive/**"],
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/mid-path wildcard/);
    expect(errs[0]).toMatch(/OS-level.*enforcement/);
  });

  it("does NOT emit mid-path wildcard diagnostic for final-segment wildcards", () => {
    _resetMidPathWildcardWarnedForTest();
    // "/home/user/**" — wildcard is in the final segment, no path separator follows.
    const errs = validateAccessPolicyConfig({
      rules: { "/home/user/**": "r--", "~/**": "rwx" },
      deny: ["/tmp/**"],
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
    const config = { rules: { "/tmp/**": "r1-" as unknown as "r--" }, default: "---" };
    expect(checkAccessPolicy("/tmp/foo.txt", "write", config)).toBe("deny");
  });

  it("treats 'R--' (uppercase) as deny for read (only lowercase 'r' grants read)", () => {
    const config = { rules: { "/tmp/**": "R--" as unknown as "r--" }, default: "---" };
    expect(checkAccessPolicy("/tmp/foo.txt", "read", config)).toBe("deny");
  });

  it("treats 'rWx' (uppercase W) as deny for write", () => {
    const config = { rules: { "/tmp/**": "rWx" as unknown as "rwx" }, default: "---" };
    expect(checkAccessPolicy("/tmp/foo.txt", "write", config)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// Trailing slash shorthand
// ---------------------------------------------------------------------------

describe("checkAccessPolicy — trailing slash shorthand", () => {
  it('"/tmp/" is equivalent to "/tmp/**"', () => {
    const config: AccessPolicyConfig = { rules: { "/tmp/": "rwx" }, default: "---" };
    expect(checkAccessPolicy("/tmp/foo.txt", "write", config)).toBe("allow");
    expect(checkAccessPolicy("/tmp/a/b/c", "write", config)).toBe("allow");
  });

  it('"~/" is equivalent to "~/**"', () => {
    const config: AccessPolicyConfig = { rules: { "~/": "rw-" }, default: "---" };
    expect(checkAccessPolicy(`${HOME}/foo.txt`, "read", config)).toBe("allow");
    expect(checkAccessPolicy(`${HOME}/foo.txt`, "write", config)).toBe("allow");
    expect(checkAccessPolicy(`${HOME}/foo.txt`, "exec", config)).toBe("deny");
  });

  it("trailing slash in deny list blocks subtree", () => {
    const config: AccessPolicyConfig = {
      rules: { "/**": "rwx" },
      deny: [`${HOME}/.ssh/`],
    };
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "read", config)).toBe("deny");
  });

  it("trailing slash and /** produce identical results", () => {
    const withSlash: AccessPolicyConfig = { rules: { "/tmp/": "rwx" }, default: "---" };
    const withGlob: AccessPolicyConfig = { rules: { "/tmp/**": "rwx" }, default: "---" };
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
      rules: { "/**": "r--", [`${HOME}/.openclaw/heartbeat/`]: "rw-" },
      default: "---",
    };
    expect(checkAccessPolicy(`${HOME}/.openclaw/heartbeat`, "write", config)).toBe("allow");
    expect(checkAccessPolicy(`${HOME}/.openclaw/heartbeat/test.txt`, "write", config)).toBe(
      "allow",
    );
  });

  it("trailing slash in deny list blocks the directory itself", () => {
    const config: AccessPolicyConfig = {
      rules: { "/**": "rwx" },
      deny: [`${HOME}/.ssh/`],
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
      rules: {
        "/tmp/**": "rwx",
        "/var/**": "r--",
        "/etc/**": "r--",
      },
      default: "---",
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

    it("deny list entry /tmp/** also blocks /private/tmp/**", () => {
      const denyConfig: AccessPolicyConfig = {
        deny: ["/tmp/**"],
        rules: { "/**": "rwx" },
      };
      expect(checkAccessPolicy("/private/tmp/evil.sh", "exec", denyConfig)).toBe("deny");
    });

    it("/private/tmp/** pattern in deny list blocks /tmp/** target", () => {
      // Pattern written with /private/tmp must still match the normalized /tmp target.
      const denyConfig: AccessPolicyConfig = {
        deny: ["/private/tmp/**"],
        rules: { "/**": "rwx" },
      };
      expect(checkAccessPolicy("/tmp/evil.sh", "read", denyConfig)).toBe("deny");
    });

    it("/private/tmp/** rule matches /tmp/** target", () => {
      // Rule written with /private/* prefix must match a /tmp/* target path.
      const cfg: AccessPolicyConfig = {
        default: "---",
        rules: { "/private/tmp/**": "rwx" },
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
// checkAccessPolicy — deny list
// ---------------------------------------------------------------------------

describe("checkAccessPolicy — deny list", () => {
  it("deny always blocks, even when a rule would allow", () => {
    const config: AccessPolicyConfig = {
      rules: { "/**": "rwx" },
      deny: [`${HOME}/.ssh/**`],
      default: "rwx",
    };
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "read", config)).toBe("deny");
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "write", config)).toBe("deny");
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "exec", config)).toBe("deny");
  });

  it.skipIf(process.platform === "win32")(
    "deny does not affect paths outside the deny glob",
    () => {
      const config: AccessPolicyConfig = {
        rules: { "/**": "rwx" },
        deny: [`${HOME}/.ssh/**`],
      };
      expect(checkAccessPolicy(`${HOME}/workspace/foo.py`, "read", config)).toBe("allow");
    },
  );

  it("multiple deny entries — first match blocks", () => {
    const config: AccessPolicyConfig = {
      rules: { "/**": "rwx" },
      deny: [`${HOME}/.ssh/**`, `${HOME}/.gnupg/**`],
    };
    expect(checkAccessPolicy(`${HOME}/.gnupg/secring.gpg`, "read", config)).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// checkAccessPolicy — rules
// ---------------------------------------------------------------------------

describe("checkAccessPolicy — rules", () => {
  it("allows read when r bit is set", () => {
    const config: AccessPolicyConfig = { rules: { "/**": "r--" } };
    expect(checkAccessPolicy("/etc/passwd", "read", config)).toBe("allow");
  });

  it("denies write when w bit is absent", () => {
    const config: AccessPolicyConfig = { rules: { "/**": "r--" } };
    expect(checkAccessPolicy("/etc/passwd", "write", config)).toBe("deny");
  });

  it("denies exec when x bit is absent", () => {
    const config: AccessPolicyConfig = { rules: { "/usr/bin/**": "r--" } };
    expect(checkAccessPolicy("/usr/bin/grep", "exec", config)).toBe("deny");
  });

  it("allows exec when x bit is set", () => {
    const config: AccessPolicyConfig = { rules: { "/usr/bin/**": "r-x" } };
    expect(checkAccessPolicy("/usr/bin/grep", "exec", config)).toBe("allow");
  });

  it("longer rule overrides shorter for the same path", () => {
    const config: AccessPolicyConfig = {
      rules: {
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
      rules: {
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
      rules: {
        [`${HOME}/**`]: "rwx",
        "~/.ssh/**": "---",
      },
    };
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "read", config, HOME)).toBe("deny");
    expect(checkAccessPolicy(`${HOME}/workspace/foo`, "write", config, HOME)).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// checkAccessPolicy — default
// ---------------------------------------------------------------------------

describe("checkAccessPolicy — default", () => {
  it("uses default when no rule matches", () => {
    const config: AccessPolicyConfig = {
      rules: { [`${HOME}/**`]: "rwx" },
      default: "r--",
    };
    expect(checkAccessPolicy("/etc/passwd", "read", config)).toBe("allow");
    expect(checkAccessPolicy("/etc/passwd", "write", config)).toBe("deny");
  });

  it("absent default is treated as --- (deny all)", () => {
    const config: AccessPolicyConfig = {
      rules: { [`${HOME}/**`]: "rwx" },
    };
    expect(checkAccessPolicy("/etc/passwd", "read", config)).toBe("deny");
  });

  it("default --- denies all ops on unmatched paths", () => {
    const config: AccessPolicyConfig = {
      rules: { [`${HOME}/workspace/**`]: "rw-" },
      default: "---",
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
  it("deny beats rules beats default — all three in play", () => {
    const config: AccessPolicyConfig = {
      rules: {
        "/**": "r--",
        [`${HOME}/**`]: "rwx",
      },
      deny: [`${HOME}/.ssh/**`],
      default: "---",
    };
    // Rule allows home paths
    expect(checkAccessPolicy(`${HOME}/workspace/foo`, "write", config)).toBe("allow");
    // Deny beats the home rule
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "read", config)).toBe("deny");
    // Outer rule applies outside home
    expect(checkAccessPolicy("/etc/hosts", "read", config)).toBe("allow");
    expect(checkAccessPolicy("/etc/hosts", "write", config)).toBe("deny");
    // Nothing matches /proc → default ---
    expect(checkAccessPolicy("/proc/self/mem", "read", config)).toBe("allow"); // matches /**
  });

  it("empty config denies everything (no rules, no default)", () => {
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
  it("denies read on resolved symlink target that falls under deny list", () => {
    // ~/workspace/link → ~/.ssh/id_rsa (symlink in allowed dir to denied file)
    // Caller passes the resolved path; deny wins.
    const config: AccessPolicyConfig = {
      rules: { [`${HOME}/workspace/**`]: "rw-" },
      deny: [`${HOME}/.ssh/**`],
      default: "---",
    };
    expect(checkAccessPolicy(`${HOME}/.ssh/id_rsa`, "read", config, HOME)).toBe("deny");
  });

  it("denies write on resolved symlink target covered by restrictive rule", () => {
    // ~/workspace/link → ~/workspace/secret/file
    // workspace is rw-, but the secret subdir is r--. Resolved path hits r--.
    const config: AccessPolicyConfig = {
      rules: {
        [`${HOME}/workspace/**`]: "rw-",
        [`${HOME}/workspace/secret/**`]: "r--",
      },
      default: "---",
    };
    expect(checkAccessPolicy(`${HOME}/workspace/secret/file.txt`, "write", config, HOME)).toBe(
      "deny",
    );
    // Read is still allowed via the r-- rule.
    expect(checkAccessPolicy(`${HOME}/workspace/secret/file.txt`, "read", config, HOME)).toBe(
      "allow",
    );
  });

  it("symlink source path in allowed dir would be allowed; resolved denied target is denied", () => {
    // This illustrates that the policy must be checked on the resolved path.
    // The symlink path itself looks allowed; the real target does not.
    const config: AccessPolicyConfig = {
      rules: { [`${HOME}/workspace/**`]: "rw-" },
      deny: [`${HOME}/.aws/**`],
      default: "---",
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
});

// ---------------------------------------------------------------------------
// applyScriptPolicyOverride
// ---------------------------------------------------------------------------

describe("applyScriptPolicyOverride", () => {
  it("returns base policy unchanged when no scripts block", () => {
    const base: AccessPolicyConfig = { rules: { "/**": "r--" }, default: "---" };
    const { policy, hashMismatch } = applyScriptPolicyOverride(base, "/any/path");
    expect(hashMismatch).toBeUndefined();
    expect(policy).toBe(base);
  });

  it("returns base policy unchanged when argv0 not in scripts", () => {
    const base: AccessPolicyConfig = {
      rules: { "/**": "r--" },
      scripts: { "/other/script.sh": { rules: { "/tmp/**": "rwx" } } },
    };
    const { policy, hashMismatch } = applyScriptPolicyOverride(base, "/my/script.sh");
    expect(hashMismatch).toBeUndefined();
    expect(policy).toBe(base);
  });

  it("returns override rules separately so seatbelt emits them after deny", () => {
    const base: AccessPolicyConfig = {
      rules: { "/**": "r--" },
      default: "---",
      scripts: { "/my/script.sh": { rules: { [`${HOME}/.openclaw/credentials/`]: "r--" } } },
    };
    const { policy, overrideRules, hashMismatch } = applyScriptPolicyOverride(
      base,
      "/my/script.sh",
    );
    expect(hashMismatch).toBeUndefined();
    // Base rules unchanged in policy
    expect(policy.rules?.["/**"]).toBe("r--");
    expect(policy.rules?.[`${HOME}/.openclaw/credentials/`]).toBeUndefined();
    // Override rules returned separately — caller emits them after deny in seatbelt profile
    expect(overrideRules?.[`${HOME}/.openclaw/credentials/`]).toBe("r--");
    expect(policy.scripts).toBeUndefined();
  });

  it("appends deny additively", () => {
    const base: AccessPolicyConfig = {
      deny: [`${HOME}/.ssh/**`],
      scripts: {
        "/my/script.sh": { deny: ["/tmp/**"] },
      },
    };
    const { policy } = applyScriptPolicyOverride(base, "/my/script.sh");
    expect(policy.deny).toContain(`${HOME}/.ssh/**`);
    expect(policy.deny).toContain("/tmp/**");
  });

  it("override rules returned separately — base policy rule unchanged", () => {
    const base: AccessPolicyConfig = {
      rules: { [`${HOME}/workspace/**`]: "r--" },
      scripts: { "/trusted.sh": { rules: { [`${HOME}/workspace/**`]: "rwx" } } },
    };
    const { policy, overrideRules } = applyScriptPolicyOverride(base, "/trusted.sh");
    expect(policy.rules?.[`${HOME}/workspace/**`]).toBe("r--");
    expect(overrideRules?.[`${HOME}/workspace/**`]).toBe("rwx");
  });

  it("narrowing override returned separately", () => {
    const base: AccessPolicyConfig = {
      rules: { "/tmp/**": "rwx" },
      scripts: { "/cautious.sh": { rules: { "/tmp/**": "r--" } } },
    };
    const { policy, overrideRules } = applyScriptPolicyOverride(base, "/cautious.sh");
    expect(policy.rules?.["/tmp/**"]).toBe("rwx");
    expect(overrideRules?.["/tmp/**"]).toBe("r--");
  });

  it("returns hashMismatch when sha256 does not match file content", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-test-"));
    const scriptPath = path.join(tmpDir, "script.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho hi\n");
    try {
      const base: AccessPolicyConfig = {
        scripts: {
          [scriptPath]: { sha256: "deadbeef".padEnd(64, "0"), rules: { "/tmp/**": "rwx" } },
        },
      };
      const { policy, hashMismatch } = applyScriptPolicyOverride(base, scriptPath);
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
      default: "rwx",
      scripts: { "~/bin/deploy.sh": { rules: { "/secret/**": "---" } } },
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
    try {
      const base: AccessPolicyConfig = {
        rules: { "/**": "r--" },
        scripts: { [scriptPath]: { sha256: hash, rules: { "/tmp/**": "rwx" } } },
      };
      const { policy, overrideRules, hashMismatch } = applyScriptPolicyOverride(base, scriptPath);
      expect(hashMismatch).toBeUndefined();
      expect(overrideRules?.["/tmp/**"]).toBe("rwx");
      expect(policy.rules?.["/tmp/**"]).toBeUndefined();
      expect(policy.scripts).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
