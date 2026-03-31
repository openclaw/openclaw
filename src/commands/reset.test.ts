import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntime } from "../runtime.js";
const resolveCleanupPlanFromDisk = vi.fn();
const removePath = vi.fn();
const listAgentSessionDirs = vi.fn();
const removeStateAndLinkedPaths = vi.fn();
const removeWorkspaceDirs = vi.fn();

vi.mock("../config/config.js", () => ({
  isNixMode: false,
}));

vi.mock("./cleanup-plan.js", () => ({
  resolveCleanupPlanFromDisk,
}));

vi.mock("./cleanup-utils.js", () => ({
  removePath,
  listAgentSessionDirs,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
}));

describe("resetCommand", () => {
  const runtime = createNonExitingRuntime();
  let resetCommand: typeof import("./reset.js").resetCommand;

  beforeAll(async () => {
    ({ resetCommand } = await import("./reset.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resolveCleanupPlanFromDisk.mockReturnValue({
      stateDir: "/tmp/.openclaw",
      configPath: "/tmp/.openclaw/openclaw.json",
      oauthDir: "/tmp/.openclaw/credentials",
      configInsideState: true,
      oauthInsideState: true,
      workspaceDirs: ["/tmp/.openclaw/workspace"],
    });
    removePath.mockResolvedValue({ ok: true });
    listAgentSessionDirs.mockResolvedValue(["/tmp/.openclaw/agents/main/sessions"]);
    removeStateAndLinkedPaths.mockResolvedValue(undefined);
    removeWorkspaceDirs.mockResolvedValue(undefined);
    vi.spyOn(runtime, "log").mockImplementation(() => {});
    vi.spyOn(runtime, "error").mockImplementation(() => {});
  });

  it("recommends creating a backup before state-destructive reset scopes", async () => {
    await resetCommand(runtime, {
      scope: "config+creds+sessions",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("openclaw backup create"));
  });

  it("does not recommend backup for config-only reset", async () => {
    await resetCommand(runtime, {
      scope: "config",
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("openclaw backup create"));
  });
});
