import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupCommandLogMessages,
  cleanupCommandErrorMessages,
  createCleanupCommandRuntime,
  gatewayService,
  removePath,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
  resetCleanupCommandMocks,
  setCleanupNixMode,
  silenceCleanupCommandRuntime,
} from "./cleanup-command.test-support.js";

const clackMocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(),
  multiselect: vi.fn(),
}));

vi.mock("@clack/prompts", () => clackMocks);

const { uninstallCommand } = await import("./uninstall.js");

describe("uninstallCommand", () => {
  const runtime = createCleanupCommandRuntime();

  const runUninstall = (options: Parameters<typeof uninstallCommand>[1]) =>
    uninstallCommand(runtime, { yes: true, nonInteractive: true, ...options });
  const expectFailure = (options: Parameters<typeof uninstallCommand>[1]) =>
    expect(runUninstall(options)).rejects.toMatchObject({ name: "ExitError", code: 1 });
  const expectDataPreserved = () => {
    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    resetCleanupCommandMocks();
    silenceCleanupCommandRuntime(runtime);
    clackMocks.confirm.mockResolvedValue(true);
    clackMocks.isCancel.mockReturnValue(false);
    clackMocks.multiselect.mockImplementation(
      async (options: { initialValues?: string[] }) => options.initialValues ?? [],
    );
  });

  it("defaults bare interactive uninstall to gateway service only", async () => {
    await uninstallCommand(runtime, { yes: true, dryRun: true });

    expect(clackMocks.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ initialValues: ["service"] }),
    );
    expect(cleanupCommandLogMessages(runtime)).toContain("[dry-run] remove gateway service");
    expectDataPreserved();
  });

  it.each(["isLoaded", "stop", "uninstall", "nix"] as const)(
    "preserves user data when gateway teardown is blocked by %s",
    async (failure) => {
      if (failure === "nix") {
        setCleanupNixMode(true);
      } else {
        gatewayService[failure].mockRejectedValue(new Error(`${failure} failed`));
      }

      await expectFailure({ all: true });
      expectDataPreserved();
      expect(cleanupCommandLogMessages(runtime)).not.toContain(
        "CLI removal instructions: https://docs.openclaw.ai/install/uninstall",
      );
      if (failure === "nix") {
        for (const mock of [
          gatewayService.isLoaded,
          gatewayService.stop,
          gatewayService.uninstall,
        ]) {
          expect(mock).not.toHaveBeenCalled();
        }
      }
    },
  );

  it("removes an unloaded service definition before deleting user data", async () => {
    gatewayService.isLoaded.mockResolvedValue(false);

    await runUninstall({ all: true });

    expect(gatewayService.stop).not.toHaveBeenCalled();
    expect(gatewayService.uninstall).toHaveBeenCalledOnce();
    expect(removeStateAndLinkedPaths).toHaveBeenCalledOnce();
    expect(removeWorkspaceDirs).toHaveBeenCalledOnce();
  });

  it("preserves workspace dirs during state-only uninstall", async () => {
    await runUninstall({ state: true, dryRun: true });
    expect(cleanupCommandLogMessages(runtime).join("\n")).toContain("openclaw backup create");
    expect(removeStateAndLinkedPaths).toHaveBeenCalledWith(
      expect.any(Object),
      runtime,
      expect.objectContaining({
        dryRun: true,
        preservePaths: ["/tmp/.openclaw/workspace"],
      }),
    );
    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: true,
      preserveWorkspace: true,
    });
  });

  it("continues state and app cleanup when retired workspace cleanup returns failures", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    removeWorkspaceDirs.mockResolvedValueOnce(["retired state failed"]);
    try {
      await expectFailure({ state: true, app: true });

      expect(removeStateAndLinkedPaths).toHaveBeenCalledOnce();
      expect(removePath).toHaveBeenCalledWith(
        "/Applications/OpenClaw.app",
        runtime,
        expect.any(Object),
      );
      expect(cleanupCommandErrorMessages(runtime).join("\n")).toContain("retired state");
    } finally {
      platform.mockRestore();
    }
  });

  it("fails when workspace cleanup returns failures", async () => {
    removeWorkspaceDirs.mockResolvedValueOnce(["/tmp/.openclaw/workspace"]);
    await expectFailure({ workspace: true });
    expect(cleanupCommandErrorMessages(runtime)).toContain(
      "Workspace cleanup incomplete: /tmp/.openclaw/workspace",
    );
  });

  it("blocks workspace cleanup after a thrown state ownership failure", async () => {
    removeStateAndLinkedPaths.mockRejectedValueOnce(new Error("state is live"));

    await expectFailure({ state: true, workspace: true });

    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
    expect(cleanupCommandErrorMessages(runtime)).toContain(
      "Workspace cleanup blocked because state cleanup could not safely complete.",
    );
  });
});
