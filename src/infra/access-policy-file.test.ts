import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROKEN_POLICY_FILE,
  _resetFileCacheForTest,
  _resetNotFoundWarnedForTest,
  loadAccessPolicyFile,
  mergeAccessPolicy,
  resolveAccessPolicyForAgent,
  resolveAccessPolicyPath,
  type AccessPolicyFile,
} from "./access-policy-file.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// The global test setup (test/setup.ts → withIsolatedTestHome) sets HOME to a
// per-worker temp directory before any tests run. os.homedir() respects HOME on
// macOS/Linux, so resolveAccessPolicyPath() resolves to
// "<testHome>/.openclaw/access-policy.json" — already isolated from the real
// user home. We just need to ensure the .openclaw dir exists and clean up the
// file after each test.

const FP_FILE = resolveAccessPolicyPath();
const FP_DIR = path.dirname(FP_FILE);

beforeEach(() => {
  fs.mkdirSync(FP_DIR, { recursive: true });
  _resetNotFoundWarnedForTest();
  _resetFileCacheForTest();
});

afterEach(() => {
  // Remove the file if a test wrote it; leave the directory to avoid races.
  try {
    fs.unlinkSync(FP_FILE);
  } catch {
    /* file may not exist — that's fine */
  }
});

function writeFile(content: AccessPolicyFile | object) {
  fs.writeFileSync(FP_FILE, JSON.stringify(content, null, 2));
}

// ---------------------------------------------------------------------------
// mergeAccessPolicy
// ---------------------------------------------------------------------------

describe("mergeAccessPolicy", () => {
  it("returns undefined when both are undefined", () => {
    expect(mergeAccessPolicy(undefined, undefined)).toBeUndefined();
  });

  it("returns base when override is undefined", () => {
    const base = { default: "r--" };
    expect(mergeAccessPolicy(base, undefined)).toEqual(base);
  });

  it("returns override when base is undefined", () => {
    const override = { default: "rwx" };
    expect(mergeAccessPolicy(undefined, override)).toEqual(override);
  });

  it("override default wins", () => {
    const result = mergeAccessPolicy({ default: "r--" }, { default: "rwx" });
    expect(result?.default).toBe("rwx");
  });

  it("base default survives when override has no default", () => {
    const result = mergeAccessPolicy({ default: "r--" }, { rules: { "/**": "r-x" } });
    expect(result?.default).toBe("r--");
  });

  it("deny arrays are concatenated — base denies cannot be removed", () => {
    const result = mergeAccessPolicy(
      { deny: ["~/.ssh/**", "~/.aws/**"] },
      { deny: ["~/.gnupg/**"] },
    );
    expect(result?.deny).toEqual(["~/.ssh/**", "~/.aws/**", "~/.gnupg/**"]);
  });

  it("override deny extends base deny", () => {
    const result = mergeAccessPolicy({ deny: ["~/.ssh/**"] }, { deny: ["~/.env"] });
    expect(result?.deny).toContain("~/.ssh/**");
    expect(result?.deny).toContain("~/.env");
  });

  it("rules are shallow-merged, override key wins on collision", () => {
    const result = mergeAccessPolicy(
      { rules: { "/**": "r--", "~/**": "rw-" } },
      { rules: { "~/**": "rwx", "~/dev/**": "rwx" } },
    );
    expect(result?.rules?.["/**"]).toBe("r--"); // base survives
    expect(result?.rules?.["~/**"]).toBe("rwx"); // override wins
    expect(result?.rules?.["~/dev/**"]).toBe("rwx"); // override adds
  });

  it("omits empty deny/rules from result", () => {
    const result = mergeAccessPolicy({ default: "r--" }, { default: "rwx" });
    expect(result?.deny).toBeUndefined();
    expect(result?.rules).toBeUndefined();
  });

  it("scripts deep-merge: base sha256 is preserved when override supplies same script key", () => {
    // Security regression: a shallow spread ({ ...base.scripts, ...override.scripts }) would
    // silently drop the admin-configured sha256 hash check, defeating integrity enforcement.
    const base = {
      scripts: {
        "/usr/local/bin/deploy.sh": {
          sha256: "abc123",
          rules: { "~/deploy/**": "rwx" as const },
          deny: ["~/.ssh/**"],
        },
      },
    };
    const override = {
      scripts: {
        "/usr/local/bin/deploy.sh": {
          // Agent block supplies same key — must NOT be able to drop sha256 or deny[].
          rules: { "~/deploy/**": "r--" as const }, // narrower override — fine
          deny: ["~/extra-deny/**"],
        },
      },
    };
    const result = mergeAccessPolicy(base, override);
    const merged = result?.scripts?.["/usr/local/bin/deploy.sh"];
    // sha256 from base must survive.
    expect(merged?.sha256).toBe("abc123");
    // deny[] must be additive — base deny cannot be removed.
    expect(merged?.deny).toContain("~/.ssh/**");
    expect(merged?.deny).toContain("~/extra-deny/**");
    // rules: override key wins on collision.
    expect(merged?.rules?.["~/deploy/**"]).toBe("r--");
  });

  it("scripts deep-merge: override-only script key is added verbatim", () => {
    const base = { scripts: { "/bin/existing.sh": { sha256: "deadbeef" } } };
    const override = {
      scripts: { "/bin/new.sh": { rules: { "/tmp/**": "rwx" as const } } },
    };
    const result = mergeAccessPolicy(base, override);
    // Base script untouched.
    expect(result?.scripts?.["/bin/existing.sh"]?.sha256).toBe("deadbeef");
    // New script from override is added.
    expect(result?.scripts?.["/bin/new.sh"]?.rules?.["/tmp/**"]).toBe("rwx");
  });

  it("scripts deep-merge: base deny[] cannot be removed by override supplying empty deny[]", () => {
    const base = {
      scripts: { "/bin/s.sh": { deny: ["~/.secrets/**"] } },
    };
    const override = {
      scripts: { "/bin/s.sh": { deny: [] } }, // empty override deny — base must survive
    };
    const result = mergeAccessPolicy(base, override);
    expect(result?.scripts?.["/bin/s.sh"]?.deny).toContain("~/.secrets/**");
  });
});

// ---------------------------------------------------------------------------
// loadAccessPolicyFile
// ---------------------------------------------------------------------------

describe("loadAccessPolicyFile", () => {
  it("returns null when file does not exist", () => {
    expect(loadAccessPolicyFile()).toBeNull();
  });

  it("returns BROKEN_POLICY_FILE and logs error when file is invalid JSON", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = resolveAccessPolicyPath();
    fs.writeFileSync(p, "not json {{ broken");
    const result = loadAccessPolicyFile();
    expect(result).toBe(BROKEN_POLICY_FILE);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Cannot parse"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Failing closed"));
    spy.mockRestore();
  });

  it("returns BROKEN_POLICY_FILE and logs error when version is not 1", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFile({ version: 2, base: {} });
    const result = loadAccessPolicyFile();
    expect(result).toBe(BROKEN_POLICY_FILE);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("unsupported version"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Failing closed"));
    spy.mockRestore();
  });

  it("returns BROKEN_POLICY_FILE and logs error when base is not an object", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFile({ version: 1, base: ["r--"] });
    const result = loadAccessPolicyFile();
    expect(result).toBe(BROKEN_POLICY_FILE);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"base" must be an object'));
    spy.mockRestore();
  });

  it("returns BROKEN_POLICY_FILE and logs error when agents is not an object", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFile({ version: 1, agents: "bad" });
    const result = loadAccessPolicyFile();
    expect(result).toBe(BROKEN_POLICY_FILE);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"agents" must be an object'));
    spy.mockRestore();
  });

  it("returns BROKEN_POLICY_FILE and logs error when a top-level key like 'rules' is misplaced", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Common mistake: rules at top level instead of under base
    writeFile({ version: 1, rules: { "/**": "r--" } });
    const result = loadAccessPolicyFile();
    expect(result).toBe(BROKEN_POLICY_FILE);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unexpected top-level key "rules"'));
    spy.mockRestore();
  });

  it("returns BROKEN_POLICY_FILE and logs error when 'deny' is misplaced at top level", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFile({ version: 1, deny: ["~/.ssh/**"] });
    const result = loadAccessPolicyFile();
    expect(result).toBe(BROKEN_POLICY_FILE);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unexpected top-level key "deny"'));
    spy.mockRestore();
  });

  it("returns BROKEN_POLICY_FILE and logs error when an agent block is not an object", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFile({ version: 1, agents: { subri: "rwx" } });
    const result = loadAccessPolicyFile();
    expect(result).toBe(BROKEN_POLICY_FILE);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('agents["subri"] must be an object'));
    spy.mockRestore();
  });

  it("returns parsed file when valid", () => {
    const content: AccessPolicyFile = {
      version: 1,
      base: { default: "r--", deny: ["~/.ssh/**"] },
      agents: { subri: { rules: { "~/dev/**": "rwx" } } },
    };
    writeFile(content);
    const result = loadAccessPolicyFile();
    expect(result).not.toBe(BROKEN_POLICY_FILE);
    expect(result).not.toBeNull();
    if (result === null || result === BROKEN_POLICY_FILE) {
      throw new Error("unexpected");
    }
    expect(result.version).toBe(1);
    expect(result.base?.default).toBe("r--");
    expect(result.agents?.subri?.rules?.["~/dev/**"]).toBe("rwx");
  });
});

// ---------------------------------------------------------------------------
// loadAccessPolicyFile — mtime cache
// ---------------------------------------------------------------------------

describe("loadAccessPolicyFile — mtime cache", () => {
  it("returns cached result on second call without re-reading the file", () => {
    writeFile({ version: 1, base: { default: "r--" } });
    const spy = vi.spyOn(fs, "readFileSync");
    loadAccessPolicyFile(); // populate cache
    loadAccessPolicyFile(); // should hit cache
    // readFileSync should only be called once despite two loadAccessPolicyFile calls.
    expect(spy.mock.calls.filter((c) => String(c[0]).includes("access-policy")).length).toBe(1);
    spy.mockRestore();
  });

  it("re-reads when mtime changes (file updated)", () => {
    writeFile({ version: 1, base: { default: "r--" } });
    loadAccessPolicyFile(); // populate cache
    // Rewrite the file — on most filesystems this bumps mtime. Force a detectable
    // mtime change by setting it explicitly via utimesSync.
    writeFile({ version: 1, base: { default: "rwx" } });
    const future = Date.now() / 1000 + 1;
    fs.utimesSync(FP_FILE, future, future);
    const result = loadAccessPolicyFile();
    expect(result).not.toBe(BROKEN_POLICY_FILE);
    if (result === null || result === BROKEN_POLICY_FILE) {
      throw new Error("unexpected");
    }
    expect(result.base?.default).toBe("rwx");
  });

  it("clears cache when file is deleted", () => {
    writeFile({ version: 1, base: { default: "r--" } });
    loadAccessPolicyFile(); // populate cache
    fs.unlinkSync(FP_FILE);
    expect(loadAccessPolicyFile()).toBeNull();
  });

  it("caches BROKEN_POLICY_FILE result for broken files", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(FP_FILE, "not json {{ broken");
    loadAccessPolicyFile(); // populate cache with BROKEN
    const spy2 = vi.spyOn(fs, "readFileSync");
    const result = loadAccessPolicyFile(); // should hit cache
    expect(result).toBe(BROKEN_POLICY_FILE);
    expect(spy2.mock.calls.filter((c) => String(c[0]).includes("access-policy")).length).toBe(0);
    spy.mockRestore();
    spy2.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// resolveAccessPolicyForAgent
// ---------------------------------------------------------------------------

describe("resolveAccessPolicyForAgent", () => {
  it("returns undefined when file does not exist", () => {
    expect(resolveAccessPolicyForAgent("subri")).toBeUndefined();
  });

  it("does not warn when config file is not found (feature is opt-in)", () => {
    // access-policy is opt-in; absence of the file is the normal state and
    // must not produce console noise for users who have not configured it.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveAccessPolicyForAgent("subri");
    resolveAccessPolicyForAgent("subri");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not warn when config file exists and is valid", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFile({ version: 1, base: { default: "r--" } });
    resolveAccessPolicyForAgent("subri");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns deny-all and logs error when config file is broken (fail-closed)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFile({ version: 1, rules: { "/**": "r--" } }); // misplaced key — triggers error
    const result = resolveAccessPolicyForAgent("subri");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Failing closed"));
    // Broken file must fail-closed: deny-all policy, not undefined
    expect(result).toEqual({ default: "---" });
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("deny-all policy returned on broken file is frozen — mutation does not corrupt future calls", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFile({ version: 1, rules: { "/**": "r--" } }); // misplaced key — broken
    const result = resolveAccessPolicyForAgent("subri");
    expect(result).toEqual({ default: "---" });
    // Attempt to mutate the returned object — must not affect the next call.
    // If DENY_ALL_POLICY is not frozen this would silently corrupt it.
    try {
      (result as Record<string, unknown>)["default"] = "rwx";
    } catch {
      // Object.freeze throws in strict mode — that's fine too.
    }
    _resetNotFoundWarnedForTest();
    const result2 = resolveAccessPolicyForAgent("subri");
    expect(result2).toEqual({ default: "---" });
    errSpy.mockRestore();
  });

  it("returns base when no agent block exists", () => {
    writeFile({
      version: 1,
      base: { default: "r--", deny: ["~/.ssh/**"] },
    });
    const result = resolveAccessPolicyForAgent("subri");
    expect(result?.default).toBe("r--");
    expect(result?.deny).toContain("~/.ssh/**");
  });

  it("merges base + named agent", () => {
    writeFile({
      version: 1,
      base: { default: "---", deny: ["~/.ssh/**"], rules: { "/**": "r--" } },
      agents: { subri: { rules: { "~/dev/**": "rwx" }, default: "r--" } },
    });
    const result = resolveAccessPolicyForAgent("subri");
    // default: agent wins
    expect(result?.default).toBe("r--");
    // deny: additive
    expect(result?.deny).toContain("~/.ssh/**");
    // rules: merged
    expect(result?.rules?.["/**"]).toBe("r--");
    expect(result?.rules?.["~/dev/**"]).toBe("rwx");
  });

  it("wildcard agent applies before named agent", () => {
    writeFile({
      version: 1,
      base: { default: "---" },
      agents: {
        "*": { rules: { "/usr/bin/**": "r-x" } },
        subri: { rules: { "~/dev/**": "rwx" } },
      },
    });
    const result = resolveAccessPolicyForAgent("subri");
    expect(result?.rules?.["/usr/bin/**"]).toBe("r-x"); // from wildcard
    expect(result?.rules?.["~/dev/**"]).toBe("rwx"); // from named agent
    expect(result?.default).toBe("---"); // from base
  });

  it("wildcard applies even when no named agent block", () => {
    writeFile({
      version: 1,
      base: { default: "---" },
      agents: { "*": { deny: ["~/.ssh/**"] } },
    });
    const result = resolveAccessPolicyForAgent("other-agent");
    expect(result?.deny).toContain("~/.ssh/**");
  });

  it("wildcard key itself is not treated as a named agent", () => {
    writeFile({
      version: 1,
      agents: { "*": { deny: ["~/.ssh/**"] } },
    });
    // Requesting agentId "*" should not double-apply wildcard as named
    const result = resolveAccessPolicyForAgent("*");
    expect(result?.deny).toEqual(["~/.ssh/**"]);
  });

  it("returns undefined when file is empty (no base, no agents)", () => {
    writeFile({ version: 1 });
    // No base and no agents → nothing to merge → undefined
    expect(resolveAccessPolicyForAgent("subri")).toBeUndefined();
  });

  it("logs console.error (not warn) when perm string is invalid", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFile({
      version: 1,
      base: { rules: { "/**": "BAD" } },
    });
    resolveAccessPolicyForAgent("subri");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("BAD"));
    expect(warnSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("does not print 'Bad permission strings' footer when only auto-expand diagnostics are present", () => {
    // Greptile: footer was printed after auto-expand messages ("rule auto-expanded to ..."),
    // misleading operators into thinking their policy was broken when it was fine.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Write a file whose rules entry is a bare directory — triggers auto-expand diagnostic
    // but no real perm-string error.
    const dir = os.tmpdir();
    writeFile({ version: 1, base: { rules: { [dir]: "r--" } } });
    resolveAccessPolicyForAgent("subri");
    const calls = errSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes("auto-expanded"))).toBe(true);
    expect(calls.some((m) => m.includes("Bad permission strings"))).toBe(false);
    errSpy.mockRestore();
  });

  it("prints 'Bad permission strings' footer when a real perm-string error is present", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFile({ version: 1, base: { rules: { "/**": "BAD" } } });
    resolveAccessPolicyForAgent("subri");
    const calls = errSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes("Bad permission strings"))).toBe(true);
    errSpy.mockRestore();
  });

  it("named agent deny extends global deny — global deny cannot be removed", () => {
    writeFile({
      version: 1,
      base: { deny: ["~/.ssh/**"] },
      agents: { paranoid: { deny: ["~/.aws/**"] } },
    });
    const result = resolveAccessPolicyForAgent("paranoid");
    expect(result?.deny).toContain("~/.ssh/**");
    expect(result?.deny).toContain("~/.aws/**");
  });
});
