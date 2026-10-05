import path from "node:path";
import { isShellWrapperInvocation } from "./shell-wrapper-resolution.js";

const CMD_SIGNIFICANT_CHARS = /[&|<>^%!()\r\n]/;
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

function hasAmbiguousControlChar(command: string): boolean {
  for (let index = 0; index < command.length; index += 1) {
    const code = command.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function splitWindowsDirectCommandLine(command: string): string[] | null {
  if (CMD_SIGNIFICANT_CHARS.test(command) || hasAmbiguousControlChar(command)) {
    return null;
  }
  if (command.includes('\\"')) {
    return null;
  }
  const argv: string[] = [];
  let index = 0;
  while (index < command.length) {
    while (isArgumentSeparator(command[index])) {
      index += 1;
    }
    if (index >= command.length) {
      break;
    }
    if (command[index] === '"') {
      const closing = command.indexOf('"', index + 1);
      if (
        closing === -1 ||
        (closing + 1 < command.length && !isArgumentSeparator(command[closing + 1]))
      ) {
        return null;
      }
      argv.push(command.slice(index + 1, closing));
      index = closing + 1;
      continue;
    }
    let end = index;
    while (end < command.length && !isArgumentSeparator(command[end])) {
      if (command[end] === '"') {
        return null;
      }
      end += 1;
    }
    argv.push(command.slice(index, end));
    index = end;
  }
  return argv.length > 0 ? argv : null;
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
