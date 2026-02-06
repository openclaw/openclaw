import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveRunWorkspaceDir } from "./workspace-run.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "./workspace.js";

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
    expect(result.workspaceDir).toBe(path.resolve(DEFAULT_AGENT_WORKSPACE_DIR));
  });

  it("warns by metadata and defaults agent id for malformed session keys", () => {
    const result = resolveRunWorkspaceDir({
      workspaceDir: undefined,
      sessionKey: "agent::broken",
      config: undefined,
    });

    expect(result.agentId).toBe("main");
    expect(result.agentIdSource).toBe("default");
    expect(result.malformedSessionKey).toBe(true);
    expect(result.workspaceDir).toBe(path.resolve(DEFAULT_AGENT_WORKSPACE_DIR));
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
    expect(result.malformedSessionKey).toBe(false);
    expect(result.workspaceDir).toBe(path.resolve(os.homedir(), ".openclaw", "workspace-research"));
  });
});
