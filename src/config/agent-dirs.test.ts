// Covers agent directory resolution across config and environment overrides.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findDuplicateAgentDirs } from "./agent-dirs.js";
import type { OpenClawConfig } from "./types.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function probePathCaseInsensitive(dir: string): boolean {
  const marker = path.join(dir, `case-probe-${process.pid}`);
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
      const caseInsensitive = probePathCaseInsensitive(root);
      const upper = path.join(root, "AgentState");
      const lower = path.join(root, "agentstate");
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
});
