import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { note } from "../terminal/note.js";

function resolveHomeDir(): string {
  return process.env.HOME ?? os.homedir();
}

export async function noteMacLaunchAgentOverrides() {
  if (process.platform !== "darwin") return;
  const markerPath = path.join(resolveHomeDir(), ".clawdbot", "disable-launchagent");
  const hasMarker = fs.existsSync(markerPath);
  if (!hasMarker) return;

  const lines = [
    `- LaunchAgent writes are disabled via ${markerPath}.`,
    "- To restore default behavior:",
    `  rm ${markerPath}`,
  ].filter((line): line is string => Boolean(line));
  note(lines.join("\n"), "Gateway (macOS)");
}
