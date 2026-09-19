import { expect, it, vi } from "vitest";
import * as windowsGitLauncher from "../infra/windows-git-launcher.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { mocks } from "./doctor-health.test-support.js";

export function registerDoctorWindowsLauncherTests(
  runDoctorHealthFlow: (typeof import("./doctor-health.js"))["runDoctorHealthFlow"],
) {
  it.each([
    { options: { nonInteractive: true }, shouldRepair: false },
    { options: { repair: true, nonInteractive: true }, shouldRepair: true },
    { options: { yes: true, nonInteractive: true }, shouldRepair: true },
  ])(
    "runs Windows launcher inspection with the Doctor repair policy: $options",
    async ({ options, shouldRepair }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const root = state.path("source-checkout");
        mocks.packageRoot.mockReturnValue(root);
        mocks.service.mockReturnValue({
          readCommand: async () => null,
          readRuntime: async () => ({ status: "stopped" }),
          isLoaded: async () => false,
          isEnabled: async () => false,
        });
        mocks.runContributions.mockImplementation(async () => {
          expect(mocks.repairWindowsGitLauncher).toHaveBeenCalledExactlyOnceWith(
            root,
            shouldRepair,
          );
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await runDoctorHealthFlow(runtime, options);
        expect(mocks.runContributions).toHaveBeenCalledOnce();
        expect(mocks.repairWindowsGitLauncher).toHaveBeenCalledExactlyOnceWith(root, shouldRepair);
        expect(runtime.exit).not.toHaveBeenCalled();
      });
    },
  );

  it("continues Doctor contributions after the real launcher adapter reports an I/O failure", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      mocks.packageRoot.mockReturnValue(state.path("source-checkout"));
      mocks.service.mockReturnValue({
        readCommand: async () => null,
        readRuntime: async () => ({ status: "stopped" }),
        isLoaded: async () => false,
        isEnabled: async () => false,
      });
      const { repairWindowsGitLauncher } = await vi.importActual<
        typeof import("../commands/doctor-install.js")
      >("../commands/doctor-install.js");
      const reconcile = vi
        .spyOn(windowsGitLauncher, "reconcileWindowsGitLauncher")
        .mockRejectedValueOnce(
          Object.assign(new Error("launcher access denied"), { code: "EACCES" }),
        );
      mocks.repairWindowsGitLauncher.mockImplementationOnce(repairWindowsGitLauncher);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      try {
        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
        expect(reconcile).toHaveBeenCalledOnce();
        expect(mocks.runContributions).toHaveBeenCalledOnce();
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
      } finally {
        reconcile.mockRestore();
      }
    });
  });
}
