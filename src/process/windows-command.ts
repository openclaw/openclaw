import path from "node:path";
import process from "node:process";

export const WINDOWS_CMD_SHIM_COMMANDS = ["npm", "npx", "pnpm", "yarn", "codex"] as const;

export function resolveWindowsCommandShim(params: {
  command: string;
  cmdCommands: readonly string[];
  platform?: NodeJS.Platform;
}): string {
  if ((params.platform ?? process.platform) !== "win32") {
    return params.command;
  }
  const basename = path.basename(params.command).toLowerCase();
  if (path.extname(basename)) {
    return params.command;
  }
  if (params.cmdCommands.includes(basename)) {
    return `${params.command}.cmd`;
  }
  return params.command;
}
