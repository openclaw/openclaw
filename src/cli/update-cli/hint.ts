import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveStateDir } from "../../config/paths.js";
import { compareSemverStrings } from "../../infra/update-check.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";

export type UpdateHintOptions = {
  json?: boolean;
};

const UpdateCheckStateSchema = z.object({
  lastCheckedAt: z.string().optional(),
  lastAvailableVersion: z.string().optional(),
  lastAvailableTag: z.string().optional(),
});
type UpdateCheckState = z.infer<typeof UpdateCheckStateSchema>;

/**
 * Lightweight hint command for agent/skill preambles.
 *
 * Reads the cached update-check state from ~/.openclaw/update-check.json
 * and prints a one-liner if an update is available. No network calls —
 * the state file is maintained by the gateway's periodic update check.
 *
 * Designed to be called from Claude Code skill preambles:
 *   _UPD=$(openclaw update hint 2>/dev/null || true)
 *   [ -n "$_UPD" ] && echo "$_UPD" || true
 */
export async function updateHintCommand(opts: UpdateHintOptions): Promise<void> {
  const statePath = path.join(resolveStateDir(), "update-check.json");

  let state: UpdateCheckState;
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const result = UpdateCheckStateSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      if (opts.json) {
        defaultRuntime.writeJson({ updateAvailable: false });
      }
      return;
    }
    state = result.data;
  } catch {
    // No state file or invalid JSON — nothing to report.
    if (opts.json) {
      defaultRuntime.writeJson({ updateAvailable: false });
    }
    return;
  }

  const latestVersion = state.lastAvailableVersion?.trim();
  if (!latestVersion) {
    if (opts.json) {
      defaultRuntime.writeJson({ updateAvailable: false });
    }
    return;
  }

  const cmp = compareSemverStrings(VERSION, latestVersion);
  if (cmp == null || cmp >= 0) {
    // Already up to date or ahead.
    if (opts.json) {
      defaultRuntime.writeJson({ updateAvailable: false });
    }
    return;
  }

  const channel = state.lastAvailableTag?.trim() || "latest";

  if (opts.json) {
    defaultRuntime.writeJson({
      updateAvailable: true,
      currentVersion: VERSION,
      latestVersion,
      channel,
    });
    return;
  }

  defaultRuntime.log(
    `UPGRADE_AVAILABLE ${VERSION} ${latestVersion} (${channel}). Run: openclaw update`,
  );
}
