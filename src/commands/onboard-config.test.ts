// Onboard config tests cover workspace, bootstrap, and local setup config mutations.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyLocalSetupWorkspaceConfig,
  resolveOnboardingWorkspaceConflict,
} from "./onboard-config.js";

describe("applyLocalSetupWorkspaceConfig", () => {
  it.each([{ profile: undefined, expectedProfile: "full" }] as const)(
    "selects $expectedProfile from $profile and preserves independent policies on rerun",
    ({ profile, expectedProfile }) => {
      const baseConfig: OpenClawConfig = {
        tools: {
          ...(profile ? { profile } : {}),
          allow: ["group:openclaw"],
          deny: ["exec"],
          byProvider: { anthropic: { profile: "messaging", deny: ["browser"] } },
          exec: { security: "deny", ask: "always" },
          fs: { workspaceOnly: true },
          sandbox: { tools: { deny: ["openclaw"] } },
        },
        agents: {
          defaults: { sandbox: { mode: "all" } },
          entries: { main: { tools: { profile: "minimal", alsoAllow: ["message"] } } },
        },
      };
      const result = applyLocalSetupWorkspaceConfig(baseConfig, "/tmp/workspace");

      expect(result.tools).toEqual({ ...baseConfig.tools, profile: expectedProfile });
      expect(result.agents).toEqual(baseConfig.agents);
    },
  );

  it("preserves the current workspace when an agent roster exists", () => {
    const baseConfig: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/tmp/current-workspace" },
        entries: { main: {}, ops: {} },
      },
    };

    const conflict = resolveOnboardingWorkspaceConflict(baseConfig, "/tmp/requested-workspace");
    const result = applyLocalSetupWorkspaceConfig(baseConfig, "/tmp/requested-workspace");

    expect(conflict).toEqual({
      currentWorkspaceDir: "/tmp/current-workspace",
      requestedWorkspaceDir: "/tmp/requested-workspace",
    });
    expect(result.agents?.defaults?.workspace).toBe("/tmp/current-workspace");
  });

  it("keeps fresh-install workspace writes when only inference state exists on disk", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onboard-state-"));
    try {
      await fs.mkdir(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
      const env = { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };

      const result = applyLocalSetupWorkspaceConfig({}, "/tmp/requested-workspace", {
        env,
      });

      expect(result.agents?.defaults?.workspace).toBe("/tmp/requested-workspace");
      const rerun = applyLocalSetupWorkspaceConfig(
        { agents: { defaults: { workspace: "/tmp/current-workspace" } } },
        "/tmp/requested-workspace",
        { env },
      );
      expect(rerun.agents?.defaults?.workspace).toBe("/tmp/current-workspace");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when existing agent state cannot be inspected", () => {
    const read = vi.spyOn(nodeFs, "readdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    try {
      const result = applyLocalSetupWorkspaceConfig(
        { agents: { defaults: { workspace: "/tmp/current-workspace" } } },
        "/tmp/requested-workspace",
        {
          env: { HOME: "/tmp/unreadable-home", OPENCLAW_STATE_DIR: "/tmp/unreadable-state" },
        },
      );
      expect(result.agents?.defaults?.workspace).toBe("/tmp/current-workspace");
    } finally {
      read.mockRestore();
    }
  });

  it("allows an explicitly confirmed workspace move", () => {
    const baseConfig: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/tmp/current-workspace" },
        entries: { main: {} },
      },
    };

    const result = applyLocalSetupWorkspaceConfig(baseConfig, "/tmp/requested-workspace", {
      allowWorkspaceChange: true,
    });

    expect(result.agents?.defaults?.workspace).toBe("/tmp/requested-workspace");
  });
});
