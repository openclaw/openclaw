import { readConfigFileSnapshot } from "../../config/config.js";
import { loadAndMaybeMigrateDoctorConfig } from "../../commands/doctor-config-flow.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadClawdbotPlugins } from "../../plugins/loader.js";
import type { RuntimeEnv } from "../../runtime.js";

const ALLOWED_INVALID_COMMANDS = new Set(["doctor", "logs", "health", "help", "status", "service"]);

function formatConfigIssues(issues: Array<{ path: string; message: string }>): string[] {
  return issues.map((issue) => `- ${issue.path || "<root>"}: ${issue.message}`);
}

export async function ensureConfigReady(params: {
  runtime: RuntimeEnv;
  commandPath?: string[];
}): Promise<void> {
  await loadAndMaybeMigrateDoctorConfig({
    options: { nonInteractive: true },
    confirm: async () => false,
  });

  const snapshot = await readConfigFileSnapshot();
  const command = params.commandPath?.[0];
  const allowInvalid = command ? ALLOWED_INVALID_COMMANDS.has(command) : false;
  const issues = snapshot.exists && !snapshot.valid ? formatConfigIssues(snapshot.issues) : [];
  const legacyIssues =
    snapshot.legacyIssues.length > 0
      ? snapshot.legacyIssues.map((issue) => `- ${issue.path}: ${issue.message}`)
      : [];

  const pluginIssues: string[] = [];
  if (snapshot.valid) {
    const workspaceDir = resolveAgentWorkspaceDir(
      snapshot.config,
      resolveDefaultAgentId(snapshot.config),
    );
    const registry = loadClawdbotPlugins({
      config: snapshot.config,
      workspaceDir: workspaceDir ?? undefined,
      cache: false,
      mode: "validate",
    });
    for (const diag of registry.diagnostics) {
      if (diag.level !== "error") continue;
      const id = diag.pluginId ? ` ${diag.pluginId}` : "";
      pluginIssues.push(`- plugin${id}: ${diag.message}`);
    }
  }

  const invalid = snapshot.exists && (!snapshot.valid || pluginIssues.length > 0);
  if (!invalid) return;

  params.runtime.error(`Config invalid at ${snapshot.path}.`);
  if (issues.length > 0) {
    params.runtime.error(issues.join("\n"));
  }
  if (legacyIssues.length > 0) {
    params.runtime.error(`Legacy config keys detected:\n${legacyIssues.join("\n")}`);
  }
  if (pluginIssues.length > 0) {
    params.runtime.error(`Plugin config errors:\n${pluginIssues.join("\n")}`);
  }
  params.runtime.error("Run `clawdbot doctor --fix` to repair, then retry.");
  if (!allowInvalid) {
    params.runtime.exit(1);
  }
}
