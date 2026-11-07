import { rememberBoundedKey } from "../../../infra/dedupe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";
import { loadDeclaredExtraBootstrapFiles } from "./declared-files.js";

const log = createSubsystemLogger("bootstrap-extra-files");
const MAX_WARNED_SKIPS = 256;
const SKIPPED_FILES_WARNING =
  "configured extra bootstrap files were not loaded. Use a supported bootstrap filename inside the workspace, or check file access: https://docs.openclaw.ai/automation/hooks/bundled-hooks#bootstrap-extra-files";
const warnedSkips = new Set<string>();

const bootstrapExtraFilesHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const context = event.context;
  try {
    const { files: extras, diagnostics } = await loadDeclaredExtraBootstrapFiles({
      config: context.cfg,
      workspaceDir: context.workspaceDir,
    });
    if (diagnostics.length > 0) {
      log.debug("skipped extra bootstrap candidates", {
        skipped: diagnostics.length,
        reasons: diagnostics.reduce<Record<string, number>>((counts, item) => {
          counts[item.reason] = (counts[item.reason] ?? 0) + 1;
          return counts;
        }, {}),
      });
    }
    // Missing files are normal; other skips mean a configured path never loads.
    const dropped = diagnostics.filter((item) => item.reason !== "missing");
    const warnKey = dropped.map((item) => `${item.reason}:${item.path}`).join("\n");
    if (dropped.length > 0 && rememberBoundedKey(warnedSkips, warnKey, MAX_WARNED_SKIPS)) {
      log.warn(SKIPPED_FILES_WARNING, {
        skipped: dropped.length,
        files: dropped.slice(0, 5),
      });
    }
    if (extras.length === 0) {
      return;
    }
    // The final bootstrap resolver owns session policy after every hook has run,
    // using the authoritative chat type and loader provenance in one place.
    context.bootstrapFiles = [...context.bootstrapFiles, ...extras];
  } catch (err) {
    log.warn(`failed: ${String(err)}`);
  }
};

export default bootstrapExtraFilesHook;
