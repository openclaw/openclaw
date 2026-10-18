// Uninstall command tests cover cleanup flow, prompts, and runtime messages.
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
    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
  });

  it.each([
    {
      failure: "inspection fails",
      arrange: () => gatewayService.isLoaded.mockRejectedValue(new Error("inspection failed")),
    },
    {
      failure: "stop fails",
      arrange: () => gatewayService.stop.mockRejectedValue(new Error("stop failed")),
    },
    {
      failure: "service removal fails",
      arrange: () => gatewayService.uninstall.mockRejectedValue(new Error("uninstall failed")),
    },
  ])("preserves user data when gateway $failure", async ({ arrange }) => {
    arrange();

    await expect(
      runUninstall({
        all: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
    expect(cleanupCommandLogMessages(runtime)).not.toContain(
      "CLI removal instructions: https://docs.openclaw.ai/install/uninstall",
    );
  });

  it("preserves user data when Nix owns service lifecycle", async () => {
    setCleanupNixMode(true);

    await expect(
      runUninstall({
        all: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(gatewayService.isLoaded).not.toHaveBeenCalled();
    expect(gatewayService.stop).not.toHaveBeenCalled();
    expect(gatewayService.uninstall).not.toHaveBeenCalled();
    expect(removeStateAndLinkedPaths).not.toHaveBeenCalled();
    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
  });

  it("removes an unloaded service definition before deleting user data", async () => {
    gatewayService.isLoaded.mockResolvedValue(false);

    await runUninstall({
      all: true,
    });

    expect(gatewayService.stop).not.toHaveBeenCalled();
    expect(gatewayService.uninstall).toHaveBeenCalledOnce();
    expect(removeStateAndLinkedPaths).toHaveBeenCalledOnce();
    expect(removeWorkspaceDirs).toHaveBeenCalledOnce();
  });

  it("recommends creating a backup before removing state or workspaces", async () => {
    await runUninstall({
      state: true,
      dryRun: true,
    });

    expect(
      cleanupCommandLogMessages(runtime).some((message) =>
        message.includes("openclaw backup create"),
      ),
    ).toBe(true);
  });

  it("preserves workspace dirs during state-only uninstall", async () => {
    await runUninstall({
      state: true,
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
    expect(removeWorkspaceDirs).toHaveBeenCalledWith(["/tmp/.openclaw/workspace"], runtime, {
      dryRun: true,
      preserveWorkspace: true,
    });
  });

  it.each([
    {
      failure: "returns failures",
      arrange: () => removeWorkspaceDirs.mockResolvedValueOnce(["retired state failed"]),
    },
  ])(
    "continues state and app cleanup when retired workspace cleanup $failure",
    async ({ arrange }) => {
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      arrange();
      try {
        await expect(
          runUninstall({
            state: true,
            app: true,
          }),
        ).rejects.toMatchObject({ name: "ExitError", code: 1 });

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
    },
  );

  it("fails when workspace cleanup returns failures", async () => {
    removeWorkspaceDirs.mockResolvedValueOnce(["/tmp/.openclaw/workspace"]);
    await expect(runUninstall({ workspace: true })).rejects.toMatchObject({
      name: "ExitError",
      code: 1,
    });
    expect(cleanupCommandErrorMessages(runtime)).toContain(
      "Workspace cleanup incomplete: /tmp/.openclaw/workspace",
    );
  });

  it("blocks workspace cleanup after a thrown state ownership failure", async () => {
    removeStateAndLinkedPaths.mockRejectedValueOnce(new Error("state is live"));

    await expect(
      runUninstall({
        state: true,
        workspace: true,
      }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(removeWorkspaceDirs).not.toHaveBeenCalled();
    expect(cleanupCommandErrorMessages(runtime)).toContain(
      "Workspace cleanup blocked because state cleanup could not safely complete.",
    );
  });
});
