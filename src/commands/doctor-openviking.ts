import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { buildPluginRuntimeNotices, buildPluginRuntimeSummaries } from "../plugins/status.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

export async function noteOpenVikingHealth(cfg: OpenClawConfig): Promise<void> {
  const isActive = cfg.plugins?.slots?.contextEngine === "openviking";
  if (!isActive) {
    return;
  }

  const lines = ["OpenViking context engine is active."];
  const memorySlot = cfg.plugins?.slots?.memory;
  if (memorySlot && memorySlot !== "none") {
    lines.push("");
    lines.push(
      `Memory slot is still set to "${memorySlot}". This keeps a second retrieval surface alongside OpenViking.`,
    );
    lines.push('If you want a single retrieval plane, set `plugins.slots.memory` to "none".');
  }

  const summary = buildPluginRuntimeSummaries({
    config: cfg,
    pluginIds: ["openviking"],
  })[0];
  if (!summary) {
    lines.push("");
    lines.push("No OpenViking runtime snapshot exists yet.");
    lines.push(
      `Run a normal agent turn, then rerun ${formatCliCommand("openclaw status")} or ${formatCliCommand("openclaw plugins inspect openviking")}.`,
    );
    note(lines.join("\n"), "OpenViking");
    return;
  }

  lines.push("");
  lines.push(`Snapshot: ${shortenHomePath(summary.snapshot.source)}`);
  for (const item of summary.snapshot.summary) {
    lines.push(`- ${item}`);
  }

  const notices = buildPluginRuntimeNotices({
    config: cfg,
    pluginIds: ["openviking"],
  });
  if (notices.length > 0) {
    lines.push("");
    lines.push("Runtime notices:");
    for (const entry of notices) {
      lines.push(`- [${entry.severity}] ${entry.message}`);
    }
  } else {
    lines.push("");
    lines.push("Runtime health: ok");
  }

  note(lines.join("\n"), "OpenViking");
}
