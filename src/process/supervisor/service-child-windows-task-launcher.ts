import path from "node:path";
import { readProcessIdentity } from "@openclaw/proc-safe/identity";
import { bindCurrentProcessLifetimeTo, PinnedProcess } from "@openclaw/proc-safe/windows-job";

/** Bind the generated launch to its verified, still-live Task Scheduler process. */
export function bindWindowsTaskLauncher(launcherKind: "wscript" | "cmd" = "wscript"): void {
  const requireProcess = (
    pid: number,
    role: string,
    access: "observe" | "lifetime-owner",
  ): PinnedProcess => {
    const owner = PinnedProcess.open(pid, { access });
    if (!owner) {
      throw new Error(`Windows task ${role} is no longer present`);
    }
    return owner;
  };
  const requireLive = (owner: PinnedProcess, role: string) => {
    if (owner.identity.exited) {
      throw new Error(`Windows task ${role} is no longer live`);
    }
  };
  const self = readProcessIdentity(process.pid);
  if (!self) {
    throw new Error("Windows task supervisor is no longer present");
  }
  let cmd: PinnedProcess | undefined;
  let launcher: PinnedProcess | undefined;
  try {
    cmd = requireProcess(
      self.parentPid,
      "CMD",
      launcherKind === "cmd" ? "lifetime-owner" : "observe",
    );
    const command = cmd.identity;
    if (
      path.win32.basename(cmd.imagePath).toLowerCase() !== "cmd.exe" ||
      command.startTimeMicros > self.startTimeMicros
    ) {
      throw new Error("Windows task supervisor lost its original CMD launcher");
    }
    if (launcherKind === "cmd") {
      requireLive(cmd, "CMD launcher");
      bindCurrentProcessLifetimeTo(cmd);
      return;
    }
    launcher = requireProcess(command.parentPid, "WScript", "lifetime-owner");
    const host = launcher.identity;
    if (
      path.win32.basename(launcher.imagePath).toLowerCase() !== "wscript.exe" ||
      host.startTimeMicros > command.startTimeMicros
    ) {
      throw new Error("Windows task supervisor lost its original WScript launcher");
    }
    // Retained handles pin identities; creation ordering rejects recycled parent PIDs.
    requireLive(cmd, "CMD launcher");
    requireLive(launcher, "WScript launcher");
    bindCurrentProcessLifetimeTo(launcher);
  } finally {
    launcher?.close();
    cmd?.close();
  }
}
