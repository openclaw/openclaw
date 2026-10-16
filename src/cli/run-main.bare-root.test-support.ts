import { expect, it, vi, type Mock } from "vitest";

export async function withCliTty(value: boolean, fn: () => Promise<void>): Promise<void> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
  try {
    await fn();
  } finally {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  }
}

export function registerBareRootArgumentTests({
  runCli,
  readConfigFileSnapshotMock,
  buildProgramMock,
  setupWizardCommandMock,
  runTuiMock,
  tryRouteCliMock,
  withInteractiveTty,
  expectNonInteractiveBareCliError,
}: {
  runCli: (argv: string[]) => Promise<void>;
  readConfigFileSnapshotMock: Mock;
  buildProgramMock: Mock;
  setupWizardCommandMock: Mock;
  runTuiMock: Mock;
  tryRouteCliMock: Mock;
  withInteractiveTty: (run: () => Promise<void>) => Promise<void>;
  expectNonInteractiveBareCliError: (message: string, assert?: () => void) => Promise<void>;
}): void {
  it("reports unknown root options instead of opening setup or the TUI", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      sourceConfig: { agents: { defaults: { workspace: "/tmp/workspace" } } },
    });
    const writeErr = vi.fn();
    const { Command } = await vi.importActual<typeof import("commander")>("commander");
    const previousBuildProgram = buildProgramMock.getMockImplementation();
    buildProgramMock.mockReturnValue(
      new Command().name("openclaw").exitOverride().configureOutput({ writeErr }),
    );
    const previousExitCode = process.exitCode;
    try {
      await withInteractiveTty(() => runCli(["node", "openclaw", "--unknown"]));
      expect(process.exitCode).toBe(1);
      expect(writeErr).toHaveBeenCalledWith(expect.stringContaining("unknown option '--unknown'"));
      expect(setupWizardCommandMock).not.toHaveBeenCalled();
      expect(runTuiMock).not.toHaveBeenCalled();
    } finally {
      buildProgramMock.mockImplementation(previousBuildProgram ?? (() => undefined));
      process.exitCode = previousExitCode;
    }
  });

  it("points noninteractive fresh bare root invocations to onboarding automation", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      exists: false,
      valid: true,
      sourceConfig: {},
    });

    await expectNonInteractiveBareCliError(
      "Onboarding needs an interactive TTY. Use `openclaw onboard --non-interactive --accept-risk ...` for automation.",
      () => {
        expect(setupWizardCommandMock).not.toHaveBeenCalled();
        expect(tryRouteCliMock).not.toHaveBeenCalled();
        expect(buildProgramMock).not.toHaveBeenCalled();
      },
    );
  });
}
