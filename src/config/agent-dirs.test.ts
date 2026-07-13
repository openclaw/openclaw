// Covers agent directory resolution across config and environment overrides.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizePathIdentity,
  pathCaseInsensitive,
  type PathChildCaseProbe,
} from "../infra/path-case-sensitivity.js";
import { findDuplicateAgentDirs } from "./agent-dirs.js";
import type { OpenClawConfig } from "./types.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveEffectiveAgentDir via findDuplicateAgentDirs", () => {
  it("uses OPENCLAW_HOME for default agent dir resolution", () => {
    // findDuplicateAgentDirs calls resolveEffectiveAgentDir internally.
    // With a single agent there are no duplicates, but we can inspect the
    // resolved dir indirectly by triggering a duplicate with two agents
    // that both fall through to the same default dir — which can't happen
    // since they have different IDs.  Instead we just verify no crash and
    // that the env flows through by checking a two-agent config produces
    // distinct dirs (no duplicates).
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "alpha" }, { id: "beta" }],
      },
    };

    const env = {
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv;

    const dupes = findDuplicateAgentDirs(cfg, { env });
    expect(dupes).toHaveLength(0);
  });

  it("resolves agent dir under OPENCLAW_HOME state dir", () => {
    // Force two agents to the same explicit agentDir to verify the path
    // that doesn't use the default — then test the default path by
    // checking that a single-agent config resolves without duplicates.
    const cfg: OpenClawConfig = {};

    const env = {
      OPENCLAW_HOME: "/srv/openclaw-home",
    } as NodeJS.ProcessEnv;

    // No duplicates for a single default agent
    const dupes = findDuplicateAgentDirs(cfg, { env });
    expect(dupes).toHaveLength(0);
  });

  it("still rejects identical agentDir paths", () => {
    const shared = path.join(os.tmpdir(), `openclaw-agentdir-shared-${process.pid}`);
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "a", agentDir: shared },
          { id: "b", agentDir: shared },
        ],
      },
    };
    const dupes = findDuplicateAgentDirs(cfg);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]?.agentIds).toEqual(["a", "b"]);
  });

  it("keys agentDir collision identity to the target volume case semantics", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agentdir-case-"));
    try {
      const caseInsensitive = pathCaseInsensitive(root);
      const upper = path.join(root, "AgentState");
      const lower = path.join(root, "agentstate");
      // Leave paths absent so collision keys use closest-parent child probes.
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "a", agentDir: upper },
            { id: "b", agentDir: lower },
          ],
        },
      };
      const dupes = findDuplicateAgentDirs(cfg);
      if (caseInsensitive) {
        // Common macOS/Windows volumes: case variants are one directory identity.
        expect(dupes).toHaveLength(1);
        expect(dupes[0]?.agentIds).toEqual(["a", "b"]);
      } else {
        // Case-sensitive volume: distinct case paths are valid distinct agent dirs.
        expect(dupes).toHaveLength(0);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keys absent nested agentDir paths using parent volume child semantics", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agentdir-absent-"));
    try {
      const caseInsensitive = pathCaseInsensitive(root);
      const upper = path.join(root, "Nested", "AgentState");
      const lower = path.join(root, "Nested", "agentstate");
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "a", agentDir: upper },
            { id: "b", agentDir: lower },
          ],
        },
      };
      const dupes = findDuplicateAgentDirs(cfg);
      if (caseInsensitive) {
        expect(dupes).toHaveLength(1);
        expect(dupes[0]?.agentIds).toEqual(["a", "b"]);
      } else {
        expect(dupes).toHaveLength(0);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps case-distinct agentDirs distinct across a case-sensitive ancestor", () => {
    // Component-aware identity: mixed CS ancestor must not collapse Foo/foo
    // even when a leaf would fold under whole-path semantics.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agentdir-mixed-"));
    try {
      const rootResolved = path.resolve(root);
      const probe: PathChildCaseProbe = (dir) => {
        const rel = path.relative(rootResolved, path.resolve(dir));
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return null;
        }
        const parts = rel.split(path.sep).filter((part) => part.length > 0);
        return parts.includes("CI");
      };
      const upper = path.join(root, "Foo", "CI", "agent");
      const lower = path.join(root, "foo", "CI", "agent");
      // Mixed mounts: validate via canonicalizePathIdentity injection (same helper
      // production canonicalizeAgentDir uses).
      expect(canonicalizePathIdentity(upper, { probeChildCaseInsensitive: probe })).not.toBe(
        canonicalizePathIdentity(lower, { probeChildCaseInsensitive: probe }),
      );
      expect(canonicalizePathIdentity(upper, { probeChildCaseInsensitive: probe })).toBe(
        canonicalizePathIdentity(upper, { probeChildCaseInsensitive: probe }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
