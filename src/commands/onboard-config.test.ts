import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyLocalSetupWorkspaceConfig,
  applySkipBootstrapConfig,
  resolveOnboardingWorkspaceConflict,
} from "./onboard-config.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const current = "/tmp/current-workspace";
const requested = "/tmp/requested-workspace";
const workspaceConfig: OpenClawConfig = { agents: { defaults: { workspace: current } } };
afterEach(() => vi.restoreAllMocks());

it("sets skipBootstrap without mutating the existing agent defaults or other config", () => {
  const config: OpenClawConfig = {
    agents: {
      defaults: { workspace: "/tmp/workspace" },
      entries: { ops: { name: "Operations" } },
    },
    gateway: { mode: "remote" },
  };
  const result = applySkipBootstrapConfig(config);

  expect(result).toEqual({
    ...config,
    agents: { ...config.agents, defaults: { workspace: "/tmp/workspace", skipBootstrap: true } },
  });
  expect(config.agents?.defaults).toEqual({ workspace: "/tmp/workspace" });
});

it("defaults to full tools and preserves independent policies on rerun", () => {
  const baseConfig: OpenClawConfig = {
    tools: {
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

  expect(result.tools).toEqual({ ...baseConfig.tools, profile: "full" });
  expect(result.agents).toEqual(baseConfig.agents);
});

it.each([false, true])("moves a roster workspace only with confirmation (%s)", (confirmed) => {
  const baseConfig: OpenClawConfig = {
    agents: {
      ...workspaceConfig.agents,
      entries: { main: {}, ops: {} },
    },
  };

  expect(resolveOnboardingWorkspaceConflict(baseConfig, requested)).toEqual({
    currentWorkspaceDir: current,
    requestedWorkspaceDir: requested,
  });
  expect(
    applyLocalSetupWorkspaceConfig(baseConfig, requested, {
      allowWorkspaceChange: confirmed,
    }).agents?.defaults?.workspace,
  ).toBe(confirmed ? requested : current);
});

it("keeps fresh-install workspace writes when only inference state exists on disk", async () => {
  const stateDir = tempDirs.make("openclaw-onboard-state-");
  await fs.mkdir(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
  const env = { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };

  const result = applyLocalSetupWorkspaceConfig({}, requested, { env });

  expect(result.agents?.defaults?.workspace).toBe(requested);
  const rerun = applyLocalSetupWorkspaceConfig(workspaceConfig, requested, { env });
  expect(rerun.agents?.defaults?.workspace).toBe(current);
});

it("fails closed when existing agent state cannot be inspected", () => {
  vi.spyOn(nodeFs, "readdirSync").mockImplementationOnce(() => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  });
  const result = applyLocalSetupWorkspaceConfig(workspaceConfig, requested, {
    env: { HOME: "/tmp/unreadable-home", OPENCLAW_STATE_DIR: "/tmp/unreadable-state" },
  });
  expect(result.agents?.defaults?.workspace).toBe(current);
});
