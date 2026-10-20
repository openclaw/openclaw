import { afterEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import * as hostSource from "../gateway/desktop/host-source.js";
import * as execRunner from "../process/exec-runner.js";
import { collectHostDesktopHealthFindings, noteHostDesktopHealth } from "./doctor-host-desktop.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

afterEach(() => {
  vi.mocked(note).mockReset();
  vi.restoreAllMocks();
});

const unavailableInspection: hostSource.HostDesktopInspection = {
  status: { enabled: true, state: "unavailable", port: 5900 },
  detail:
    "gateway host desktop is unavailable at 127.0.0.1:5900. Enable System Settings -> General -> Sharing -> Screen Sharing.",
  unavailableReason: "not-listening",
};

function commandResult(code: number) {
  return {
    stdout: "",
    stderr: "",
    code,
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

const hostConfig = { desktop: { host: { enabled: true } } };
const managedConfig = { desktop: { host: { enabled: true, managed: true } } };

function prepareRepair(approved: boolean, code = 0) {
  const inspection = vi
    .spyOn(hostSource, "inspectHostDesktop")
    .mockResolvedValue(unavailableInspection);
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  const runCommand = vi
    .spyOn(execRunner, "runCommandWithTimeout")
    .mockResolvedValue(commandResult(code));
  const confirmRuntimeRepair = vi.fn(async () => approved);
  return {
    inspection,
    runCommand,
    confirmRuntimeRepair,
    run: () =>
      noteHostDesktopHealth(hostConfig, {
        prompter: { shouldRepair: true, confirmRuntimeRepair },
      }),
  };
}

describe("host desktop doctor section", () => {
  it("reports managed configured and failed states distinctly", async () => {
    vi.spyOn(hostSource, "inspectHostDesktop")
      .mockResolvedValueOnce({
        status: { enabled: true, state: "managed", managedState: "unknown", port: 5900 },
        detail: "managed (configured; runtime state is available from the running Gateway status)",
      })
      .mockResolvedValueOnce({
        status: {
          enabled: true,
          state: "managed",
          managedState: "failed",
          port: 46_001,
          display: 99,
          error: "startxfce4 not installed",
        },
        detail: "managed (failed: startxfce4 not installed)",
      });

    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    await noteHostDesktopHealth(managedConfig);
    expect(note).toHaveBeenCalledWith(
      "managed (configured; runtime state is available from the running Gateway status)",
      "Host desktop",
    );
    await expect(collectHostDesktopHealthFindings(managedConfig)).resolves.toEqual([
      expect.objectContaining({
        severity: "warning",
        message: "managed (failed: startxfce4 not installed)",
      }),
    ]);
  });

  it("runs the exact Screen Sharing launchctl repair only after interactive confirmation", async () => {
    const { inspection, runCommand, confirmRuntimeRepair, run } = prepareRepair(true);
    inspection.mockResolvedValueOnce(unavailableInspection).mockResolvedValueOnce({
      status: { enabled: true, state: "attached", port: 5900, security: "ARD" },
      detail: "attached (127.0.0.1:5900, security: ARD)",
    });
    await run();

    expect(confirmRuntimeRepair).toHaveBeenCalledWith({
      message:
        "Enable macOS Screen Sharing now using sudo launchctl? This system service may accept connections from other network interfaces according to macOS Sharing settings.",
      initialValue: false,
      requiresInteractiveConfirmation: true,
    });
    expect(runCommand.mock.calls.map(([argv]) => argv)).toEqual([
      ["sudo", "launchctl", "enable", "system/com.apple.screensharing"],
      ["sudo", "launchctl", "kickstart", "-k", "system/com.apple.screensharing"],
    ]);
    expect(note).toHaveBeenCalledWith("attached (127.0.0.1:5900, security: ARD)", "Host desktop");
  });

  it("prints the System Settings path when interactive repair is declined", async () => {
    const { runCommand, run } = prepareRepair(false);
    await run();
    expect(runCommand).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "Enable Screen Sharing manually in System Settings → General → Sharing → Screen Sharing.",
      "Host desktop repair",
    );
  });

  it("stops after a failed sudo command and prints both manual repair paths", async () => {
    const { runCommand, run } = prepareRepair(true, 1);
    await run();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(
        "sudo launchctl enable system/com.apple.screensharing && sudo launchctl kickstart -k system/com.apple.screensharing",
      ),
      "Host desktop repair",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("System Settings → General → Sharing → Screen Sharing"),
      "Host desktop repair",
    );
  });
});
