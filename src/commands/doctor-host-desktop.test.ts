import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import * as hostSource from "../gateway/desktop/host-source.js";
import * as execRunner from "../process/exec-runner.js";
import { collectHostDesktopHealthFindings, noteHostDesktopHealth } from "./doctor-host-desktop.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
const hostConfig = { desktop: { host: { enabled: true } } };
const manualPath = "System Settings → General → Sharing → Screen Sharing";
const repairCommand =
  "sudo launchctl enable system/com.apple.screensharing && sudo launchctl kickstart -k system/com.apple.screensharing";
const unavailable: hostSource.HostDesktopInspection = {
  status: { enabled: true, state: "unavailable", port: 5900 },
  detail: "Screen Sharing unavailable",
  unavailableReason: "not-listening",
};
beforeEach(() => {
  vi.spyOn(hostSource, "inspectHostDesktop").mockResolvedValue(unavailable);
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
});
afterEach(() => {
  vi.mocked(note).mockReset();
  vi.restoreAllMocks();
});

async function repair(approved: boolean, code = 0) {
  const runCommand = vi.spyOn(execRunner, "runCommandWithTimeout").mockResolvedValue({
    stdout: "",
    stderr: "",
    code,
    signal: null,
    killed: false,
    termination: "exit",
  });
  const confirmRuntimeRepair = vi.fn(async () => approved);
  await noteHostDesktopHealth(hostConfig, {
    prompter: { shouldRepair: true, confirmRuntimeRepair },
  });
  return { runCommand, confirmRuntimeRepair };
}

it("reports managed configured and failed states distinctly", async () => {
  const config = { desktop: { host: { enabled: true, managed: true } } };
  vi.mocked(hostSource.inspectHostDesktop)
    .mockReset()
    .mockResolvedValueOnce({
      status: { enabled: true, state: "managed", managedState: "unknown", port: 5900 },
      detail: "managed (configured)",
    })
    .mockResolvedValueOnce({
      status: { enabled: true, state: "managed", managedState: "failed", port: 46_001 },
      detail: "managed (failed: startxfce4 not installed)",
    });
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  await noteHostDesktopHealth(config);
  expect(note).toHaveBeenCalledWith("managed (configured)", "Host desktop");
  await expect(collectHostDesktopHealthFindings(config)).resolves.toMatchObject([
    { severity: "warning", message: "managed (failed: startxfce4 not installed)" },
  ]);
});

it("runs the exact Screen Sharing repair only after interactive confirmation", async () => {
  vi.mocked(hostSource.inspectHostDesktop)
    .mockReset()
    .mockResolvedValueOnce(unavailable)
    .mockResolvedValueOnce({
      status: { enabled: true, state: "attached", port: 5900, security: "ARD" },
      detail: "attached (127.0.0.1:5900, security: ARD)",
    });
  const { runCommand, confirmRuntimeRepair } = await repair(true);
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

it.each([
  { approved: false, code: 0, commands: 0 },
  { approved: true, code: 1, commands: 1 },
])(
  "reports manual repair after approval=$approved, exit=$code",
  async ({ approved, code, commands }) => {
    const { runCommand } = await repair(approved, code);
    expect(runCommand).toHaveBeenCalledTimes(commands);
    if (!approved) {
      expect(note).toHaveBeenCalledWith(
        `Enable Screen Sharing manually in ${manualPath}.`,
        "Host desktop repair",
      );
    } else {
      for (const text of [repairCommand, manualPath]) {
        expect(note).toHaveBeenCalledWith(expect.stringContaining(text), "Host desktop repair");
      }
    }
  },
);
