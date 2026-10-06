import path from "node:path";
import { isShellWrapperInvocation } from "./shell-wrapper-resolution.js";

const CMD_OPERATOR_CHARS = /[&|<>^()\r\n]/;
const CMD_INTERNAL_COMMANDS = new Set([
  "assoc",
  "break",
  "call",
  "cd",
  "chdir",
  "cls",
  "color",
  "copy",
  "date",
  "del",
  "dir",
  "dpath",
  "echo",
  "endlocal",
  "erase",
  "exit",
  "for",
  "ftype",
  "goto",
  "if",
  "keys",
  "md",
  "mkdir",
  "mklink",
  "move",
  "path",
  "pause",
  "popd",
  "prompt",
  "pushd",
  "rd",
  "rem",
  "ren",
  "rename",
  "rmdir",
  "set",
  "setlocal",
  "shift",
  "start",
  "time",
  "title",
  "type",
  "ver",
  "verify",
  "vol",
]);

function isArgumentSeparator(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

function hasForbiddenControlChar(command: string): boolean {
  for (let index = 0; index < command.length; index += 1) {
    const code = command.charCodeAt(index);
    const lineBreakOrTab = code === 0x09 || code === 0x0a || code === 0x0d;
    if ((code < 0x20 && !lineBreakOrTab) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function readProgramName(command: string): { program: string; next: number } | null {
  if (command.startsWith('"')) {
    const closing = command.indexOf('"', 1);
    const program = closing === -1 ? "" : command.slice(1, closing);
    const glued = closing + 1 < command.length && !isArgumentSeparator(command[closing + 1]);
    if (!program || /[\r\n]/.test(program) || glued) {
      return null;
    }
    return { program, next: closing + 1 };
  }
  let end = 0;
  while (end < command.length && !isArgumentSeparator(command[end])) {
    end += 1;
  }
  const program = command.slice(0, end);
  if (!program || program.includes('"') || CMD_OPERATOR_CHARS.test(program)) {
    return null;
  }
  return { program, next: end };
}

function splitArguments(
  command: string,
  start: number,
  doubledQuoteInQuotes: "stays-quoted" | "ends-quote",
): string[] | null {
  const argv: string[] = [];
  let index = start;
  while (index < command.length) {
    while (isArgumentSeparator(command[index])) {
      index += 1;
    }
    if (index >= command.length) {
      break;
    }
    let arg = "";
    let quoted = false;
    while (index < command.length) {
      const ch = command[index] ?? "";
      if (ch === "\\") {
        let run = 0;
        while (command[index + run] === "\\") {
          run += 1;
        }
        if (command[index + run] !== '"') {
          arg += "\\".repeat(run);
          index += run;
          continue;
        }
        arg += "\\".repeat(Math.floor(run / 2));
        index += run;
        if (run % 2 === 1) {
          arg += '"';
          index += 1;
        }
        continue;
      }
      if (ch === '"') {
        if (quoted && command[index + 1] === '"') {
          arg += '"';
          index += 2;
          quoted = doubledQuoteInQuotes === "stays-quoted";
          continue;
        }
        quoted = !quoted;
        index += 1;
        continue;
      }
      if (!quoted && isArgumentSeparator(ch)) {
        break;
      }
      if (!quoted && CMD_OPERATOR_CHARS.test(ch)) {
        return null;
      }
      arg += ch;
      index += 1;
    }
    if (quoted && doubledQuoteInQuotes === "stays-quoted") {
      return null;
    }
    argv.push(arg);
  }
  return argv;
}

export function splitWindowsDirectCommandLine(rawCommand: string): string[] | null {
  const command = rawCommand.replace(/^[ \t]+/, "");
  if (hasForbiddenControlChar(command)) {
    return null;
  }
  const head = readProgramName(command);
  if (!head) {
    return null;
  }
  const runtimeArgs = splitArguments(command, head.next, "stays-quoted");
  const shellArgs = splitArguments(command, head.next, "ends-quote");
  if (
    !runtimeArgs ||
    !shellArgs ||
    runtimeArgs.length !== shellArgs.length ||
    runtimeArgs.some((arg, index) => arg !== shellArgs[index])
  ) {
    return null;
  }
  return [head.program, ...runtimeArgs];
}

function isCmdInternalCommand(executable: string): boolean {
  const name = path.win32.basename(executable).toLowerCase();
  const leadingWord = /^[a-z]+/.exec(name)?.[0];
  if (!leadingWord || !CMD_INTERNAL_COMMANDS.has(leadingWord)) {
    return false;
  }
  const next = name[leadingWord.length];
  return next === undefined || !/[a-z0-9]/.test(next);
}

function isBatchScript(executable: string): boolean {
  const name = path.win32
    .basename(executable)
    .toLowerCase()
    .replace(/[. ]+$/, "");
  return /\.(cmd|bat)(:|$)/.test(name);
}

export function resolveWindowsDirectCommandArgv(command: string): string[] | null {
  const argv = splitWindowsDirectCommandLine(command.trim());
  const executable = argv?.[0];
  if (
    !argv ||
    !executable ||
    isCmdInternalCommand(executable) ||
    isBatchScript(executable) ||
    isShellWrapperInvocation(argv)
  ) {
    return null;
  }
  return argv;
}
