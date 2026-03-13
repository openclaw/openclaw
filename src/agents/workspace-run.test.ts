import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveRunWorkspaceDir } from "./workspace-run.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

const PARENT_WORKSPACE = "/home/user/workspace-parent";
const SDR_WORKSPACE = "/home/user/workspace-sdr";
const OTHER_WORKSPACE = "/home/user/workspace-other";

const configWithSdrWorkspace = {
  agents: {
    list: [
      { id: "sdr", workspace: SDR_WORKSPACE },
      { id: "parent", workspace: PARENT_WORKSPACE },
    ],
  },
};

describe("resolveRunWorkspaceDir", () => {
  it("resolves explicit workspace values without fallback", () => {
    const explicit = path.join(process.cwd(), "tmp", "workspace-run-explicit");
    const result = resolveRunWorkspaceDir({
      workspaceDir: explicit,
      sessionKey: "agent:main:subagent:test",
    });

    expect(result.usedFallback).toBe(false);
    expect(result.agentId).toBe("main");
    expect(result.workspaceDir).toBe(path.resolve(explicit));
  });

  it("falls back to configured per-agent workspace when input is missing", () => {
    const defaultWorkspace = path.join(process.cwd(), "tmp", "workspace-default-main");
    const researchWorkspace = path.join(process.cwd(), "tmp", "workspace-research");
    const cfg = {
      agents: {
        defaults: { workspace: defaultWorkspace },
        list: [{ id: "research", workspace: researchWorkspace }],
      },
    } satisfies OpenClawConfig;

    const result = resolveRunWorkspaceDir({
      workspaceDir: undefined,
      sessionKey: "agent:research:subagent:test",
      config: cfg,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe("missing");
    expect(result.agentId).toBe("research");
    expect(result.workspaceDir).toBe(path.resolve(researchWorkspace));
  });

  it("falls back to default workspace for blank strings", () => {
    const defaultWorkspace = path.join(process.cwd(), "tmp", "workspace-default-main");
    const cfg = {
      agents: {
        defaults: { workspace: defaultWorkspace },
      },
    } satisfies OpenClawConfig;

    const result = resolveRunWorkspaceDir({
      workspaceDir: "   ",
      sessionKey: "agent:main:subagent:test",
      config: cfg,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe("blank");
    expect(result.agentId).toBe("main");
    expect(result.workspaceDir).toBe(path.resolve(defaultWorkspace));
  });

  it("falls back to built-in main workspace when config is unavailable", () => {
    const result = resolveRunWorkspaceDir({
      workspaceDir: null,
      sessionKey: "agent:main:subagent:test",
      config: undefined,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe("missing");
    expect(result.agentId).toBe("main");
    expect(result.workspaceDir).toBe(path.resolve(resolveDefaultAgentWorkspaceDir(process.env)));
  });

  it("throws for malformed agent session keys", () => {
    expect(() =>
      resolveRunWorkspaceDir({
        workspaceDir: undefined,
        sessionKey: "agent::broken",
        config: undefined,
      }),
    ).toThrow("Malformed agent session key");
  });

  it("uses explicit agent id for per-agent fallback when config is unavailable", () => {
    const result = resolveRunWorkspaceDir({
      workspaceDir: undefined,
      sessionKey: "definitely-not-a-valid-session-key",
      agentId: "research",
      config: undefined,
    });

    expect(result.agentId).toBe("research");
    expect(result.agentIdSource).toBe("explicit");
    expect(result.workspaceDir).toBe(
      path.resolve(resolveStateDir(process.env), "workspace-research"),
    );
  });

  it("throws for malformed agent session keys even when config has a default agent", () => {
    const mainWorkspace = path.join(process.cwd(), "tmp", "workspace-main-default");
    const researchWorkspace = path.join(process.cwd(), "tmp", "workspace-research-default");
    const cfg = {
      agents: {
        defaults: { workspace: mainWorkspace },
        list: [
          { id: "main", workspace: mainWorkspace },
          { id: "research", workspace: researchWorkspace, default: true },
        ],
      },
    } satisfies OpenClawConfig;

    expect(() =>
      resolveRunWorkspaceDir({
        workspaceDir: undefined,
        sessionKey: "agent::broken",
        config: cfg,
      }),
    ).toThrow("Malformed agent session key");
  });

  it("treats non-agent legacy keys as default, not malformed", () => {
    const fallbackWorkspace = path.join(process.cwd(), "tmp", "workspace-default-legacy");
    const cfg = {
      agents: {
        defaults: { workspace: fallbackWorkspace },
      },
    } satisfies OpenClawConfig;

    const result = resolveRunWorkspaceDir({
      workspaceDir: undefined,
      sessionKey: "custom-main-key",
      config: cfg,
    });

    expect(result.agentId).toBe("main");
    expect(result.agentIdSource).toBe("default");
    expect(result.workspaceDir).toBe(path.resolve(fallbackWorkspace));
  });

  describe("subagent workspace isolation", () => {
    it("uses agent configured workspace instead of inherited parent workspaceDir", () => {
      const result = resolveRunWorkspaceDir({
        workspaceDir: PARENT_WORKSPACE,
        agentId: "sdr",
        config: configWithSdrWorkspace,
      });
      expect(result.workspaceDir).toBe(path.resolve(SDR_WORKSPACE));
      expect(result.usedFallback).toBe(false);
      expect(result.agentId).toBe("sdr");
    });

    it("uses agent configured workspace even when a different workspaceDir is provided", () => {
      const result = resolveRunWorkspaceDir({
        workspaceDir: OTHER_WORKSPACE,
        agentId: "sdr",
        config: configWithSdrWorkspace,
      });
      expect(result.workspaceDir).toBe(path.resolve(SDR_WORKSPACE));
      expect(result.usedFallback).toBe(false);
    });
  });

  describe("no agent workspace configured", () => {
    it("uses the provided workspaceDir when agent has no configured workspace", () => {
      const result = resolveRunWorkspaceDir({
        workspaceDir: OTHER_WORKSPACE,
        agentId: "sdr",
        config: { agents: { list: [{ id: "sdr" }] } },
      });
      expect(result.workspaceDir).toBe(path.resolve(OTHER_WORKSPACE));
      expect(result.usedFallback).toBe(false);
    });

    it("uses the provided workspaceDir when config has no agents list", () => {
      const result = resolveRunWorkspaceDir({
        workspaceDir: OTHER_WORKSPACE,
      });
      expect(result.workspaceDir).toBe(path.resolve(OTHER_WORKSPACE));
      expect(result.usedFallback).toBe(false);
    });
  });

  describe("fallback when no workspaceDir provided", () => {
    it("falls back when workspaceDir is missing, reports reason", () => {
      const result = resolveRunWorkspaceDir({
        workspaceDir: undefined,
        agentId: "sdr",
        config: configWithSdrWorkspace,
      });
      expect(result.workspaceDir).toBe(path.resolve(SDR_WORKSPACE));
      expect(result.usedFallback).toBe(true);
      expect(result.fallbackReason).toBe("missing");
    });

    it("falls back when workspaceDir is blank, reports reason", () => {
      const result = resolveRunWorkspaceDir({
        workspaceDir: "   ",
        agentId: "sdr",
        config: configWithSdrWorkspace,
      });
      expect(result.workspaceDir).toBe(path.resolve(SDR_WORKSPACE));
      expect(result.usedFallback).toBe(true);
      expect(result.fallbackReason).toBe("blank");
    });

    it("falls back when workspaceDir is invalid type, reports reason", () => {
      const result = resolveRunWorkspaceDir({
        workspaceDir: 42,
        agentId: "sdr",
        config: configWithSdrWorkspace,
      });
      expect(result.workspaceDir).toBe(path.resolve(SDR_WORKSPACE));
      expect(result.usedFallback).toBe(true);
      expect(result.fallbackReason).toBe("invalid_type");
    });
  });
});
