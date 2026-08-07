// Uninstall command tests cover cleanup flow, prompts, and runtime messages.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupCommandLogMessages,
  createCleanupCommandRuntime,
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
  resetCleanupCommandMocks,
  silenceCleanupCommandRuntime,
} from "./cleanup-command.test-support.js";

const gatewayService = vi.hoisted(() => ({
  notLoadedText: "is not installed",
  isLoaded: vi.fn(),
  stop: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => gatewayService,
}));

const { uninstallCommand } = await import("./uninstall.js");

describe("uninstallCommand", () => {
  const runtime = createCleanupCommandRuntime();

  beforeEach(() => {
    resetCleanupCommandMocks();
    silenceCleanupCommandRuntime(runtime);
    gatewayService.isLoaded.mockReset().mockResolvedValueOnce(true).mockResolvedValue(false);
    gatewayService.stop.mockReset().mockResolvedValue(undefined);
    gatewayService.uninstall.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    {
      name: "the gateway service cannot be inspected",
      arrange: () => {
        gatewayService.isLoaded.mockReset().mockRejectedValue(new Error("service check failed"));
      },
    },
    {
      name: "the loaded gateway service cannot be uninstalled",
      arrange: () => {
        gatewayService.uninstall.mockRejectedValue(new Error("service uninstall failed"));
      },
    },
    {
      name: "the gateway service remains loaded after uninstall",
      arrange: () => {
        gatewayService.isLoaded.mockReset().mockResolvedValue(true);
      },
    },
    {
      name: "the uninstalled gateway service can no longer be inspected",
      arrange: () => {
        gatewayService.isLoaded
          .mockReset()
          .mockResolvedValueOnce(true)
          .mockRejectedValueOnce(new Error("final service check failed"));
      },
    },
  ])("preserves all user data and exits nonzero when $name", async ({ arrange }) => {
    arrange();

    await expect(
      uninstallCommand(runtime, {
        all: true,
        yes: true,
        nonInteractive: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
    expect(prepareLegacyWorkspaceStateReset).not.toHaveBeenCalled();
    expect(cleanupCommandLogMessages(runtime)).not.toContain(
      "CLI still installed. Remove via npm/pnpm if desired.",
    );
  });

  it("exits nonzero when a service-only uninstall fails", async () => {
    gatewayService.uninstall.mockRejectedValue(new Error("service uninstall failed"));

    await expect(
      uninstallCommand(runtime, {
        service: true,
        yes: true,
        nonInteractive: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
  });

  it("removes all requested data after verifying the gateway is no longer loaded", async () => {
    await uninstallCommand(runtime, {
      all: true,
      yes: true,
      nonInteractive: true,
    });

    expect(gatewayService.stop).toHaveBeenCalledOnce();
    expect(gatewayService.uninstall).toHaveBeenCalledOnce();
    expect(gatewayService.isLoaded).toHaveBeenCalledTimes(2);
    expect(removeStateAndLinkedPaths).toHaveBeenCalledOnce();
    expect(removeWorkspaceDirs).toHaveBeenCalledOnce();
  });

  it("continues an idempotent full uninstall when the service is not installed", async () => {
    gatewayService.isLoaded.mockReset().mockResolvedValue(false);

    await uninstallCommand(runtime, {
      all: true,
      yes: true,
      nonInteractive: true,
    });

    expect(gatewayService.stop).not.toHaveBeenCalled();
    expect(gatewayService.uninstall).not.toHaveBeenCalled();
    expect(removeStateAndLinkedPaths).toHaveBeenCalledOnce();
    expect(removeWorkspaceDirs).toHaveBeenCalledOnce();
  });

  it("preserves all user data when Nix owns the gateway service", async () => {
    vi.resetModules();
    vi.doMock("../config/config.js", () => ({ isNixMode: true }));

    try {
      const { uninstallCommand: uninstallNixService } = await import("./uninstall.js");

      await expect(
        uninstallNixService(runtime, {
          all: true,
          yes: true,
          nonInteractive: true,
        }),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });

      expect(gatewayService.isLoaded).not.toHaveBeenCalled();
      expect(gatewayService.stop).not.toHaveBeenCalled();
      expect(gatewayService.uninstall).not.toHaveBeenCalled();
      expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
      expect(removeWorkspaceDirs).not.toHaveBeenCalled();
    } finally {
      vi.doMock("../config/config.js", () => ({ isNixMode: false }));
      vi.resetModules();
    }
  });

  it("recommends creating a backup before removing state or workspaces", async () => {
    await uninstallCommand(runtime, {
      state: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(
      cleanupCommandLogMessages(runtime).some((message) =>
        message.includes("openclaw backup create"),
      ),
    ).toBe(true);
  });

  it("does not recommend backup for service-only uninstall", async () => {
    await uninstallCommand(runtime, {
      service: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(
      cleanupCommandLogMessages(runtime).some((message) =>
        message.includes("openclaw backup create"),
      ),
    ).toBe(false);
  });

  it("preserves workspace dirs during state-only uninstall", async () => {
    await uninstallCommand(runtime, {
      state: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeStateAndLinkedPaths).toHaveBeenCalledWith(
      expect.any(Object),
      runtime,
      expect.objectContaining({
        dryRun: true,
        preservePaths: ["/tmp/.openclaw/workspace"],
      }),
    );
  });

  it("previews retired workspace files during state-only uninstall", async () => {
    removeLegacyWorkspaceStateForReset.mockResolvedValueOnce({
      removedPaths: ["/tmp/.openclaw/workspace/openclaw-workspace-state.json"],
      warnings: [],
    });

    await uninstallCommand(runtime, {
      state: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(prepareLegacyWorkspaceStateReset).toHaveBeenCalledWith("/tmp/.openclaw/workspace");
    expect(removeLegacyWorkspaceStateForReset).toHaveBeenCalledWith(
      { workspaceDir: "/tmp/.openclaw/workspace" },
      { dryRun: true },
    );
    expect(cleanupCommandLogMessages(runtime)).toContain(
      "[dry-run] remove /tmp/.openclaw/workspace/openclaw-workspace-state.json",
    );
  });

  it("does not preserve workspace dirs when workspace removal is selected", async () => {
    await uninstallCommand(runtime, {
      state: true,
      workspace: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeStateAndLinkedPaths).toHaveBeenCalledWith(
      expect.any(Object),
      runtime,
      expect.objectContaining({
        dryRun: true,
        preservePaths: [],
      }),
    );
  });

  it("removes workspace state rows during workspace-only uninstall", async () => {
    await uninstallCommand(runtime, {
      workspace: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: true,
      removeStateRows: true,
    });
  });

  it("does not reopen workspace state after state and workspace uninstall", async () => {
    await uninstallCommand(runtime, {
      state: true,
      workspace: true,
      yes: true,
      nonInteractive: true,
      dryRun: true,
    });

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: true,
      removeStateRows: false,
    });
  });

  it("removes workspace rows when combined state removal fails", async () => {
    removeStateAndLinkedPaths.mockResolvedValueOnce(false);

    await uninstallCommand(runtime, {
      state: true,
      workspace: true,
      yes: true,
      nonInteractive: true,
    });

    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: false,
      removeStateRows: true,
    });
  });
});
