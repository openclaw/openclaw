import { readConfigFileSnapshot } from "../../config/config.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { loadAndMaybeMigrateDoctorConfig } from "../../commands/doctor-config-flow.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadClawdbotPlugins } from "../../plugins/loader.js";
import type { RuntimeEnv } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";

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
  const commandName = params.commandPath?.[0];
  const allowInvalid = commandName ? ALLOWED_INVALID_COMMANDS.has(commandName) : false;
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

  const rich = isRich();
  const muted = (value: string) => colorize(rich, theme.muted, value);
  const error = (value: string) => colorize(rich, theme.error, value);
  const heading = (value: string) => colorize(rich, theme.heading, value);
  const commandText = (value: string) => colorize(rich, theme.command, value);

  params.runtime.error(heading("Config invalid"));
  params.runtime.error(`${muted("File:")} ${muted(snapshot.path)}`);
  if (issues.length > 0) {
    params.runtime.error(muted("Problem:"));
    params.runtime.error(issues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  if (legacyIssues.length > 0) {
    params.runtime.error(muted("Legacy config keys detected:"));
    params.runtime.error(legacyIssues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  if (pluginIssues.length > 0) {
    params.runtime.error(muted("Plugin config errors:"));
    params.runtime.error(pluginIssues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  params.runtime.error("");
  params.runtime.error(
    `${muted("Run:")} ${commandText(formatCliCommand("clawdbot doctor --fix"))}`,
  );
  if (!allowInvalid) {
    params.runtime.exit(1);
  }
}
