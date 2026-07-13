// Covers filesystem case-sensitivity probes and component-aware path identity.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizePathIdentity,
  pathCaseInsensitive,
  type PathChildCaseProbe,
} from "./path-case-sensitivity.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-path-case-"));
  tempRoots.push(root);
  return root;
}

function probeChildCaseInsensitive(dir: string): boolean {
  const marker = path.join(dir, `caseProbeChild-${process.pid}`);
  fs.writeFileSync(marker, "x", "utf8");
  try {
    const swapped = marker.replace(/[A-Za-z]/g, (char) => {
      const lower = char.toLowerCase();
      return char === lower ? char.toUpperCase() : lower;
    });
    if (swapped === marker) {
      return process.platform === "win32";
    }
    try {
      const a = fs.statSync(marker);
      const b = fs.statSync(swapped);
      return a.dev === b.dev && a.ino === b.ino;
    } catch {
      return false;
    }
  } finally {
    fs.rmSync(marker, { force: true });
  }
}

/**
 * Simulate mixed case-sensitivity without host volume side effects:
 * only parents that already contain a `CI` path segment fold children.
 * All other parents (including `/` and temp ancestors) are case-sensitive.
 */
function mixedBoundaryProbe(): PathChildCaseProbe {
  return (dir: string) => {
    // Match a CI segment as built so far (before leaf folding rewrites it).
    return /(^|[\\/])CI([\\/]|$)/.test(path.resolve(dir));
  };
}

describe("pathCaseInsensitive", () => {
  it("matches child lookup semantics on the host temp volume", () => {
    const root = makeTempRoot();
    const expected = probeChildCaseInsensitive(root);
    expect(pathCaseInsensitive(root)).toBe(expected);
  });

  it("uses closest existing parent for absent nested paths", () => {
    const root = makeTempRoot();
    const absent = path.join(root, "AgentState", "nested", "missing");
    const expected = probeChildCaseInsensitive(root);
    expect(pathCaseInsensitive(absent)).toBe(expected);
  });

  it("probes an existing empty directory via temporary child marker", () => {
    const root = makeTempRoot();
    const empty = path.join(root, "emptyDir");
    fs.mkdirSync(empty);
    const expected = probeChildCaseInsensitive(empty);
    expect(pathCaseInsensitive(empty)).toBe(expected);
  });

  it("probes via an existing lettered child without leaving a marker", () => {
    const root = makeTempRoot();
    const child = path.join(root, "LetterEntry");
    fs.writeFileSync(child, "x", "utf8");
    const before = new Set(fs.readdirSync(root));
    const result = pathCaseInsensitive(path.join(root, "does-not-exist-yet"));
    const after = new Set(fs.readdirSync(root));
    expect(result).toBe(probeChildCaseInsensitive(root));
    expect(after).toEqual(before);
  });
});

describe("canonicalizePathIdentity", () => {
  it("folds whole path when every parent is case-insensitive", () => {
    const root = makeTempRoot();
    if (!probeChildCaseInsensitive(root)) {
      return;
    }
    const upper = path.join(root, "AgentState", "Nested");
    const lower = path.join(root, "agentstate", "nested");
    const key = canonicalizePathIdentity(upper);
    expect(key).toBe(canonicalizePathIdentity(lower));
    // Folded identity ends with lowercased leaf segments (ancestor temp dirs may also fold).
    expect(key.endsWith(`${path.sep}agentstate${path.sep}nested`)).toBe(true);
  });

  it("preserves case when every parent is case-sensitive", () => {
    const root = makeTempRoot();
    // Host temp is usually CI on macOS; force CS via injected probe.
    const probe: PathChildCaseProbe = () => false;
    const upper = path.join(root, "AgentState");
    const lower = path.join(root, "agentstate");
    expect(canonicalizePathIdentity(upper, { probeChildCaseInsensitive: probe })).toBe(
      path.resolve(upper),
    );
    expect(canonicalizePathIdentity(lower, { probeChildCaseInsensitive: probe })).toBe(
      path.resolve(lower),
    );
    expect(canonicalizePathIdentity(upper, { probeChildCaseInsensitive: probe })).not.toBe(
      canonicalizePathIdentity(lower, { probeChildCaseInsensitive: probe }),
    );
  });

  it("preserves case-sensitive ancestor components under mixed boundaries", () => {
    // CS ancestor + CI descendant: whole-path fold would collapse Foo/foo.
    const root = makeTempRoot();
    const probe = mixedBoundaryProbe();

    const a = path.join(root, "CS", "Foo", "CI", "Agent");
    const b = path.join(root, "CS", "foo", "CI", "Agent");
    const keyA = canonicalizePathIdentity(a, { probeChildCaseInsensitive: probe });
    const keyB = canonicalizePathIdentity(b, { probeChildCaseInsensitive: probe });

    expect(keyA).not.toBe(keyB);
    // Ancestor Foo/foo stays distinct; only CI-parented segments fold.
    expect(keyA).toContain(`${path.sep}Foo${path.sep}`);
    expect(keyB).toContain(`${path.sep}foo${path.sep}`);
    expect(keyA.endsWith(`${path.sep}agent`)).toBe(true);
    expect(keyB.endsWith(`${path.sep}agent`)).toBe(true);
  });

  it("folds only CI-parented segments on a mixed boundary path", () => {
    const root = makeTempRoot();
    const probe = mixedBoundaryProbe();

    const mixed = path.join(root, "CS", "KeepCase", "CI", "AgentState");
    const key = canonicalizePathIdentity(mixed, { probeChildCaseInsensitive: probe });
    // KeepCase under CS parent stays; AgentState under CI parent folds.
    expect(key).toContain(`${path.sep}KeepCase${path.sep}`);
    expect(key.endsWith(`${path.sep}agentstate`)).toBe(true);
    expect(key).not.toContain("AgentState");
  });

  it("fails closed when probe returns null (does not fold)", () => {
    const root = makeTempRoot();
    const probe: PathChildCaseProbe = () => null;
    const upper = path.join(root, "TrustedBin");
    const lower = path.join(root, "trustedbin");
    expect(canonicalizePathIdentity(upper, { probeChildCaseInsensitive: probe })).toBe(
      path.resolve(upper),
    );
    expect(canonicalizePathIdentity(upper, { probeChildCaseInsensitive: probe })).not.toBe(
      canonicalizePathIdentity(lower, { probeChildCaseInsensitive: probe }),
    );
  });

  it("does not conflate distinct dirs across a case-sensitive ancestor (safe-bin shape)", () => {
    // Security: trusted /CS/Trusted/bin must not match /CS/trusted/bin when ancestor is CS.
    const root = makeTempRoot();
    const probe = mixedBoundaryProbe();
    const trusted = path.join(root, "CS", "Trusted", "bin");
    const alias = path.join(root, "CS", "trusted", "bin");
    expect(canonicalizePathIdentity(trusted, { probeChildCaseInsensitive: probe })).not.toBe(
      canonicalizePathIdentity(alias, { probeChildCaseInsensitive: probe }),
    );
  });
});
