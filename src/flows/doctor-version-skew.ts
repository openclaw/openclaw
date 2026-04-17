import { formatCliCommand } from "../cli/command-format.js";
import { shouldWarnOnTouchedVersion } from "../config/version.js";
import { note } from "../terminal/note.js";
import { VERSION } from "../version.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";

export async function runVersionSkewHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const touched = ctx.cfg.meta?.lastTouchedVersion;
  if (!touched || typeof touched !== "string") {
    return;
  }

  if (shouldWarnOnTouchedVersion(VERSION, touched)) {
    note(
      [
        `Config was last written by OpenClaw ${touched}, but the running binary is ${VERSION}.`,
        "Plugins or features added by the newer version may not load correctly.",
        `Fix: run ${formatCliCommand("openclaw update")} to update the binary.`,
        `Or: run ${formatCliCommand("npm install -g openclaw@latest")} for a manual update.`,
      ].join("\n"),
      "Version skew",
    );
  }
}
