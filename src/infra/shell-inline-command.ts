import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export const POSIX_INLINE_COMMAND_FLAGS = new Set(["-lc", "-c", "--command"]);
export const POWERSHELL_INLINE_COMMAND_FLAGS = new Set([
  "-c",
  "-command",
  "--command",
  "-f",
  "-file",
  "-encodedcommand",
  "-enc",
  "-e",
]);

export function resolveInlineCommandMatch(
  argv: string[],
  flags: ReadonlySet<string>,
  options: { allowCombinedC?: boolean } = {},
): { command: string | null; valueTokenIndex: number | null } {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]?.trim();
    if (!token) {
      continue;
    }
    const lower = normalizeLowercaseStringOrEmpty(token);
    if (lower === "--") {
      break;
    }
    if (flags.has(lower)) {
      const valueTokenIndex = i + 1 < argv.length ? i + 1 : null;
      const command = argv[i + 1]?.trim();
      return { command: command ? command : null, valueTokenIndex };
    }
    if (options.allowCombinedC && /^-[^-]*c[^-]*$/i.test(token)) {
      const commandIndex = lower.indexOf("c");
      const inline = token.slice(commandIndex + 1).trim();
      if (inline) {
        return { command: inline, valueTokenIndex: i };
      }
      const valueTokenIndex = i + 1 < argv.length ? i + 1 : null;
      const command = argv[i + 1]?.trim();
      return { command: command ? command : null, valueTokenIndex };
    }
  }
  return { command: null, valueTokenIndex: null };
}
