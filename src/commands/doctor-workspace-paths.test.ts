import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { detectStaleWorkspacePaths, type StaleWorkspacePathEnv } from "./doctor-workspace-paths.js";

function makeCfg(
  workspaces: {
    defaults?: string;
    list?: Array<{ id: string; workspace?: string }>;
  } = {},
): OpenClawConfig {
  const agents: Record<string, unknown> = {};
  if (workspaces.defaults !== undefined) {
    agents.defaults = { workspace: workspaces.defaults };
  }
  if (workspaces.list !== undefined) {
    agents.list = workspaces.list;
  }
  return { agents } as unknown as OpenClawConfig;
}

function makeEnv(over: Partial<StaleWorkspacePathEnv> = {}): StaleWorkspacePathEnv {
  return {
    homedir: "/Users/alice",
    username: "alice",
    platform: "darwin",
    pathExists: () => false,
    ...over,
  };
}

describe("detectStaleWorkspacePaths", () => {
  it("returns no findings for an empty config", () => {
    expect(detectStaleWorkspacePaths(makeCfg(), makeEnv())).toEqual([]);
  });

  it("skips ~-relative defaults.workspace", () => {
    const cfg = makeCfg({ defaults: "~/.openclaw/workspace" });
    expect(detectStaleWorkspacePaths(cfg, makeEnv())).toEqual([]);
  });

  it("skips relative paths", () => {
    const cfg = makeCfg({ defaults: "./workspace" });
    expect(detectStaleWorkspacePaths(cfg, makeEnv())).toEqual([]);
  });

  it("skips absolute paths that exist on the current host", () => {
    const cfg = makeCfg({ defaults: "/Users/alice/.openclaw/workspace" });
    const findings = detectStaleWorkspacePaths(cfg, makeEnv({ pathExists: () => true }));
    expect(findings).toEqual([]);
  });

  it("flags a Linux-shaped path on a macOS host as stale", () => {
    const cfg = makeCfg({ defaults: "/home/alice/.openclaw/workspace" });
    const findings = detectStaleWorkspacePaths(cfg, makeEnv());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "stale-home-prefix",
      location: "agents.defaults.workspace",
      currentValue: "/home/alice/.openclaw/workspace",
      proposedRewrite: "~/.openclaw/workspace",
    });
  });

  it("flags a macOS-shaped path on a Linux host as stale", () => {
    const cfg = makeCfg({ defaults: "/Users/alice/.openclaw/ws" });
    const findings = detectStaleWorkspacePaths(
      cfg,
      makeEnv({ platform: "linux", homedir: "/home/alice" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "stale-home-prefix",
      proposedRewrite: "~/.openclaw/ws",
    });
  });

  it("flags a Windows-shaped path on a macOS host as stale", () => {
    const cfg = makeCfg({ defaults: "C:\\Users\\alice\\.openclaw\\ws" });
    const findings = detectStaleWorkspacePaths(cfg, makeEnv());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "stale-home-prefix",
      proposedRewrite: "~/.openclaw/ws",
    });
  });

  it("flags a different-user Linux home as stale even on Linux", () => {
    const cfg = makeCfg({ defaults: "/home/bob/.openclaw/workspace" });
    const findings = detectStaleWorkspacePaths(
      cfg,
      makeEnv({ platform: "linux", homedir: "/home/alice" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe("stale-home-prefix");
  });

  it("flags /root paths as stale for non-root users", () => {
    const cfg = makeCfg({ defaults: "/root/.openclaw/ws" });
    const findings = detectStaleWorkspacePaths(
      cfg,
      makeEnv({ platform: "linux", homedir: "/home/alice" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "stale-home-prefix",
      proposedRewrite: "~/.openclaw/ws",
    });
  });

  it("reports non-home absolute paths that don't exist as missing-nonhome without a rewrite", () => {
    const cfg = makeCfg({ defaults: "/mnt/data/openclaw-ws" });
    const findings = detectStaleWorkspacePaths(cfg, makeEnv());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "missing-nonhome",
      currentValue: "/mnt/data/openclaw-ws",
    });
    expect(findings[0]).not.toHaveProperty("proposedRewrite");
  });

  it("preserves nested subpaths in the rewrite", () => {
    const cfg = makeCfg({ defaults: "/home/alice/work/custom/path" });
    const findings = detectStaleWorkspacePaths(cfg, makeEnv());
    expect(findings[0].kind).toBe("stale-home-prefix");
    if (findings[0].kind === "stale-home-prefix") {
      expect(findings[0].proposedRewrite).toBe("~/work/custom/path");
    }
  });

  it("rewrites a bare home root to ~", () => {
    const cfg = makeCfg({ defaults: "/home/alice" });
    const findings = detectStaleWorkspacePaths(cfg, makeEnv());
    expect(findings[0].kind).toBe("stale-home-prefix");
    if (findings[0].kind === "stale-home-prefix") {
      expect(findings[0].proposedRewrite).toBe("~");
    }
  });

  it("emits findings per stale agent entry and leaves healthy ones alone", () => {
    const cfg = makeCfg({
      defaults: "/home/alice/.openclaw/workspace",
      list: [
        { id: "ok-tilde", workspace: "~/other-ws" },
        { id: "ok-local", workspace: "/Users/alice/local-ws" },
        { id: "stale", workspace: "/home/alice/stale-ws" },
      ],
    });
    const findings = detectStaleWorkspacePaths(
      cfg,
      makeEnv({ pathExists: (p) => p === "/Users/alice/local-ws" }),
    );
    expect(findings.map((f) => f.location)).toEqual([
      "agents.defaults.workspace",
      "agents.list[2].workspace",
    ]);
    for (const f of findings) {
      expect(f.kind).toBe("stale-home-prefix");
    }
    const stale = findings.find((f) => f.location === "agents.list[2].workspace");
    expect(stale).toBeDefined();
    if (stale && stale.kind === "stale-home-prefix") {
      expect(stale.agentId).toBe("stale");
      expect(stale.proposedRewrite).toBe("~/stale-ws");
    }
  });

  it("does not flag paths when current user's home is a prefix (local-missing is skipped)", () => {
    const cfg = makeCfg({ defaults: "/Users/alice/missing-locally" });
    const findings = detectStaleWorkspacePaths(cfg, makeEnv({ pathExists: () => false }));
    expect(findings).toEqual([]);
  });
});
