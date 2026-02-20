import { execSync } from "node:child_process";
import { logVerbose } from "../../globals.js";
import type { CommandHandler } from "./commands-types.js";

export interface CustomCommandConfig {
  description?: string;
  exec: string;
  reply?: boolean;
  ownerOnly?: boolean;
}

export type CustomCommandsMap = Record<string, CustomCommandConfig>;

/**
 * Resolve custom commands from config.
 * Config path: commands.custom
 */
function resolveCustomCommands(cfg: {
  commands?: { custom?: CustomCommandsMap };
}): CustomCommandsMap {
  return cfg.commands?.custom ?? {};
}

/**
 * Interpolate variables in exec string:
 *   ${ARGS} — everything after the command name
 *   ${WORKSPACE} — workspace directory
 */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function interpolateExec(template: string, args: string, workspaceDir: string): string {
  return template
    .replace(/\$\{ARGS\}/g, shellEscape(args))
    .replace(/\$\{WORKSPACE\}/g, workspaceDir);
}

export const handleCustomCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const customCommands = resolveCustomCommands(params.cfg);
  if (!customCommands || Object.keys(customCommands).length === 0) {
    return null;
  }

  const body = params.command.commandBodyNormalized;

  for (const [name, config] of Object.entries(customCommands)) {
    const slash = `/${name}`;
    const isExact = body === slash || body === name;
    const isWithArgs = body.startsWith(`${slash} `) || body.startsWith(`${name} `);

    if (!isExact && !isWithArgs) {
      continue;
    }

    // Check owner-only restriction
    if (config.ownerOnly !== false && !params.command.isAuthorizedSender) {
      logVerbose(
        `Ignoring custom command /${name} from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }

    const args = isWithArgs ? body.slice((body.startsWith("/") ? slash : name).length).trim() : "";

    const execStr = interpolateExec(config.exec, args, params.workspaceDir);

    logVerbose(`Custom command /${name}: exec=${execStr}`);

    try {
      const output = execSync(execStr, {
        cwd: params.workspaceDir,
        timeout: 10_000,
        encoding: "utf-8",
        env: {
          ...process.env,
          OPENCLAW_WORKSPACE: params.workspaceDir,
          OPENCLAW_SESSION_KEY: params.sessionKey ?? "",
          OPENCLAW_COMMAND_ARGS: args,
        },
      }).trim();

      if (config.reply !== false) {
        return {
          shouldContinue: false,
          reply: { text: output || "(no output)" },
        };
      }

      return { shouldContinue: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logVerbose(`Custom command /${name} failed: ${message}`);
      return {
        shouldContinue: false,
        reply: { text: `⚠️ Custom command \`/${name}\` failed:\n${message}` },
      };
    }
  }

  return null;
};
