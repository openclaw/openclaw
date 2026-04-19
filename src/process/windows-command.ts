import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export function resolveWindowsCommandShim(params: {
  command: string;
  cmdCommands: readonly string[];
  platform?: NodeJS.Platform;
}): string {
  if ((params.platform ?? process.platform) !== "win32") {
    return params.command;
  }
  const basename = normalizeLowercaseStringOrEmpty(path.basename(params.command));
  if (path.extname(basename)) {
    return params.command;
  }
  if (params.cmdCommands.includes(basename)) {
    return `${params.command}.cmd`;
  }
  return params.command;
}

export function resolveWindowsCmdShimArgv(
  argv: readonly string[],
  options?: { platform?: NodeJS.Platform; pathEnv?: string },
): string[] {
  const result = [...argv];
  if ((options?.platform ?? process.platform) !== "win32") {
    return result;
  }
  let shimPath = result[0];
  if (!shimPath || !shimPath.toLowerCase().endsWith(".cmd")) {
    return result;
  }
  if (!shimPath.includes("\\") && !shimPath.includes("/")) {
    const pathEnv = options?.pathEnv ?? process.env.PATH ?? "";
    for (const dir of pathEnv.split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, shimPath);
      if (fs.existsSync(candidate)) {
        shimPath = candidate;
        break;
      }
    }
  }
  let shimContent: string;
  try {
    shimContent = fs.readFileSync(shimPath, "utf8");
  } catch {
    return result;
  }
  const match = shimContent.match(/"%(?:~?dp0)%\\?([^"]+\.(?:exe|js))"/i);
  if (!match) {
    return result;
  }
  const target = path.join(path.dirname(shimPath), match[1]);
  if (!fs.existsSync(target)) {
    return result;
  }
  if (normalizeLowercaseStringOrEmpty(path.extname(target)) === ".js") {
    return [process.execPath, target, ...result.slice(1)];
  }
  result[0] = target;
  return result;
}
