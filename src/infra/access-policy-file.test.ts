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
    const base = { policy: { "/**": "r--" as const } };
    expect(mergeAccessPolicy(base, undefined)).toEqual(base);
  });

  it("returns override when base is undefined", () => {
    const override = { policy: { "/**": "rwx" as const } };
    expect(mergeAccessPolicy(undefined, override)).toEqual(override);
  });

  it("rules are shallow-merged, override key wins on collision", () => {
    const result = mergeAccessPolicy(
      { policy: { "/**": "r--", "~/**": "rw-" } },
      { policy: { "~/**": "rwx", "~/dev/**": "rwx" } },
    );
    expect(result?.policy?.["/**"]).toBe("r--"); // base survives
    expect(result?.policy?.["~/**"]).toBe("rwx"); // override wins
    expect(result?.policy?.["~/dev/**"]).toBe("rwx"); // override adds
  });

  it("omits empty rules from result", () => {
    const result = mergeAccessPolicy({ scripts: { "/s.sh": { sha256: "abc" } } }, {});
    expect(result?.policy).toBeUndefined();
  });

  it("scripts deep-merge: base sha256 is preserved when override supplies same script key", () => {
    // Security regression: a shallow spread ({ ...base.scripts, ...override.scripts }) would
    // silently drop the admin-configured sha256 hash check, defeating integrity enforcement.
    const base = {
      scripts: {
        "/usr/local/bin/deploy.sh": {
          sha256: "abc123",
          policy: { "~/deploy/**": "rwx" as const },
        },
      },
    };
    const override = {
      scripts: {
        "/usr/local/bin/deploy.sh": {
          // Agent block supplies same key — must NOT be able to drop sha256.
          policy: { "~/deploy/**": "r--" as const }, // narrower override — fine
        },
      },
    };
    const result = mergeAccessPolicy(base, override);
    const merged = result?.scripts?.["/usr/local/bin/deploy.sh"] as
      | import("../config/types.tools.js").ScriptPolicyEntry
      | undefined;
    // sha256 from base must survive.
    expect(merged?.sha256).toBe("abc123");
    // policy: override key wins on collision.
    expect(merged?.policy?.["~/deploy/**"]).toBe("r--");
  });

  it("scripts deep-merge: override-only script key is added verbatim", () => {
    const base = { scripts: { "/bin/existing.sh": { sha256: "deadbeef" } } };
    const override = {
      scripts: { "/bin/new.sh": { policy: { "/tmp/**": "rwx" as const } } },
    };
    const result = mergeAccessPolicy(base, override);
    // Base script untouched.
    expect(result?.scripts?.["/bin/existing.sh"]?.sha256).toBe("deadbeef");
    // New script from override is added.
    const newScript = result?.scripts?.["/bin/new.sh"] as
      | import("../config/types.tools.js").ScriptPolicyEntry
      | undefined;
    expect(newScript?.policy?.["/tmp/**"]).toBe("rwx");
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

  it('returns BROKEN_POLICY_FILE and logs error when base is placed at top level (use agents["*"])', () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFile({ version: 1, base: { policy: { "/**": "r--" } } });
    const result = loadAccessPolicyFile();
    expect(result).toBe(BROKEN_POLICY_FILE);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unexpected top-level key "base"'));
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

  it("returns BROKEN_POLICY_FILE and logs error when a top-level key like 'policy' is misplaced", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Common mistake: policy at top level instead of under agents["*"]
    writeFile({ version: 1, policy: { "/**": "r--" } });
    const result = loadAccessPolicyFile();
    expect(result).toBe(BROKEN_POLICY_FILE);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unexpected top-level key "policy"'));
    spy.mockRestore();
  });

  it("returns BROKEN_POLICY_FILE and logs error when 'scripts' is misplaced at top level", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFile({ version: 1, scripts: { "/bin/s.sh": { sha256: "abc" } } });
    const result = loadAccessPolicyFile();
    expect(result).toBe(BROKEN_POLICY_FILE);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unexpected top-level key "scripts"'));
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
      agents: {
        "*": { policy: { "/**": "r--", "~/.ssh/**": "---" } },
        subri: { policy: { "~/dev/**": "rwx" } },
      },
    };
    writeFile(content);
    const result = loadAccessPolicyFile();
    expect(result).not.toBe(BROKEN_POLICY_FILE);
    expect(result).not.toBeNull();
    if (result === null || result === BROKEN_POLICY_FILE) {
      throw new Error("unexpected");
    }
    expect(result.version).toBe(1);
    expect(result.agents?.["*"]?.policy?.["/**"]).toBe("r--");
    expect(result.agents?.subri?.policy?.["~/dev/**"]).toBe("rwx");
  });
});

// ---------------------------------------------------------------------------
// loadAccessPolicyFile — mtime cache
// ---------------------------------------------------------------------------

describe("loadAccessPolicyFile — mtime cache", () => {
  it("returns cached result on second call without re-reading the file", () => {
    writeFile({ version: 1, agents: { "*": { policy: { "/**": "r--" } } } });
    const spy = vi.spyOn(fs, "readFileSync");
    loadAccessPolicyFile(); // populate cache
    loadAccessPolicyFile(); // should hit cache
    // readFileSync should only be called once despite two loadAccessPolicyFile calls.
    expect(spy.mock.calls.filter((c) => String(c[0]).includes("access-policy")).length).toBe(1);
    spy.mockRestore();
  });

  it("re-reads when mtime changes (file updated)", () => {
    writeFile({ version: 1, agents: { "*": { policy: { "/**": "r--" } } } });
    loadAccessPolicyFile(); // populate cache
    // Rewrite the file — on most filesystems this bumps mtime. Force a detectable
    // mtime change by setting it explicitly via utimesSync.
    writeFile({ version: 1, agents: { "*": { policy: { "/**": "rwx" } } } });
    const future = Date.now() / 1000 + 1;
    fs.utimesSync(FP_FILE, future, future);
    const result = loadAccessPolicyFile();
    expect(result).not.toBe(BROKEN_POLICY_FILE);
    if (result === null || result === BROKEN_POLICY_FILE) {
      throw new Error("unexpected");
    }
    expect(result.agents?.["*"]?.policy?.["/**"]).toBe("rwx");
  });

  it("clears cache when file is deleted", () => {
    writeFile({ version: 1, agents: { "*": { policy: { "/**": "r--" } } } });
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
    writeFile({ version: 1, agents: { "*": { policy: { "/**": "r--" } } } });
    resolveAccessPolicyForAgent("subri");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns deny-all and logs error when config file is broken (fail-closed)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFile({ version: 1, policy: { "/**": "r--" } }); // misplaced key — triggers error
    const result = resolveAccessPolicyForAgent("subri");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Failing closed"));
    // Broken file must fail-closed: deny-all policy (empty rules = implicit "---"), not undefined
    expect(result).toEqual({});
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("deny-all policy returned on broken file is frozen — mutation does not corrupt future calls", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFile({ version: 1, policy: { "/**": "r--" } }); // misplaced key — broken
    const result = resolveAccessPolicyForAgent("subri");
    expect(result).toEqual({});
    // Attempt to mutate the returned object — must not affect the next call.
    // If DENY_ALL_POLICY is not frozen this would silently corrupt it.
    try {
      (result as Record<string, unknown>)["rules"] = { "/**": "rwx" };
    } catch {
      // Object.freeze throws in strict mode — that's fine too.
    }
    _resetNotFoundWarnedForTest();
    const result2 = resolveAccessPolicyForAgent("subri");
    expect(result2).toEqual({});
    errSpy.mockRestore();
  });

  it("returns base when no agent block exists", () => {
    writeFile({
      version: 1,
      agents: { "*": { policy: { "/**": "r--", [`~/.ssh/**`]: "---" } } },
    });
    const result = resolveAccessPolicyForAgent("subri");
    expect(result?.policy?.["/**"]).toBe("r--");
    expect(result?.policy?.["~/.ssh/**"]).toBe("---");
  });

  it("merges base + named agent", () => {
    writeFile({
      version: 1,
      agents: {
        "*": { policy: { "/**": "r--", [`~/.ssh/**`]: "---" } },
        subri: { policy: { "~/dev/**": "rwx" } },
      },
    });
    const result = resolveAccessPolicyForAgent("subri");
    // policy: merged, agent rule wins on collision
    expect(result?.policy?.["/**"]).toBe("r--");
    expect(result?.policy?.["~/dev/**"]).toBe("rwx");
    // base "---" rule preserved
    expect(result?.policy?.["~/.ssh/**"]).toBe("---");
  });

  it("wildcard agent applies before named agent", () => {
    writeFile({
      version: 1,
      agents: {
        "*": { policy: { "/usr/bin/**": "r-x" } },
        subri: { policy: { "~/dev/**": "rwx" } },
      },
    });
    const result = resolveAccessPolicyForAgent("subri");
    expect(result?.policy?.["/usr/bin/**"]).toBe("r-x"); // from wildcard
    expect(result?.policy?.["~/dev/**"]).toBe("rwx"); // from named agent
  });

  it("wildcard applies even when no named agent block", () => {
    writeFile({
      version: 1,
      agents: { "*": { policy: { [`~/.ssh/**`]: "---" } } },
    });
    const result = resolveAccessPolicyForAgent("other-agent");
    expect(result?.policy?.["~/.ssh/**"]).toBe("---");
  });

  it("wildcard key itself is not treated as a named agent", () => {
    writeFile({
      version: 1,
      agents: { "*": { policy: { [`~/.ssh/**`]: "---" } } },
    });
    // Requesting agentId "*" should not double-apply wildcard as named
    const result = resolveAccessPolicyForAgent("*");
    expect(result?.policy?.["~/.ssh/**"]).toBe("---");
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
      agents: { "*": { policy: { "/**": "BAD" } } },
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
    writeFile({ version: 1, agents: { "*": { policy: { [dir]: "r--" } } } });
    resolveAccessPolicyForAgent("subri");
    const calls = errSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes("auto-expanded"))).toBe(true);
    expect(calls.some((m) => m.includes("Bad permission strings"))).toBe(false);
    errSpy.mockRestore();
  });

  it("prints 'Bad permission strings' footer when a real perm-string error is present", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFile({ version: 1, agents: { "*": { policy: { "/**": "BAD" } } } });
    resolveAccessPolicyForAgent("subri");
    const calls = errSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes("Bad permission strings"))).toBe(true);
    errSpy.mockRestore();
  });

  it("narrowing rules from base and agent are all preserved in merged result", () => {
    writeFile({
      version: 1,
      agents: {
        "*": { policy: { [`~/.ssh/**`]: "---" } },
        paranoid: { policy: { [`~/.aws/**`]: "---" } },
      },
    });
    const result = resolveAccessPolicyForAgent("paranoid");
    expect(result?.policy?.["~/.ssh/**"]).toBe("---");
    expect(result?.policy?.["~/.aws/**"]).toBe("---");
  });
});
