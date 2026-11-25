import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import {
  extractShellWrapperCommand,
  hasEnvManipulationBeforeShellWrapper,
  normalizeExecutableToken,
  unwrapDispatchWrappersForResolution,
  unwrapKnownShellMultiplexerInvocation,
} from "./exec-wrapper-resolution.js";
import {
  NUSHELL_INLINE_COMMAND_FLAGS,
  POSIX_INLINE_COMMAND_FLAGS,
  isPowerShellInlineRestCommandFlag,
  resolveInlineCommandMatch,
  resolvePowerShellInlineCommandMatch,
} from "./shell-inline-command.js";
import { formatExecCommand, POSIX_SHELL_WRAPPERS } from "./shell-wrapper-resolution.js";

export { formatExecCommand } from "./shell-wrapper-resolution.js";

type ResolvedSystemRunCommand =
  | {
      ok: true;
      argv: string[];
      commandText: string;
      shellPayload: string | null;
      previewText: string | null;
    }
  | {
      ok: false;
      message: string;
      details?: Record<string, unknown>;
    };

/** Extract the inline shell payload carried by a shell wrapper argv. */
export function extractShellCommandFromArgv(argv: string[]): string | null {
  return extractShellWrapperCommand(argv).command;
}

const POSIX_OR_POWERSHELL_INLINE_WRAPPER_NAMES = new Set([
  ...POSIX_SHELL_WRAPPERS,
  "powershell",
  "pwsh",
]);

function unwrapShellWrapperArgv(argv: string[]): string[] {
  const dispatchUnwrapped = unwrapDispatchWrappersForResolution(argv);
  const shellMultiplexer = unwrapKnownShellMultiplexerInvocation(dispatchUnwrapped);
  return shellMultiplexer.kind === "unwrapped" ? shellMultiplexer.argv : dispatchUnwrapped;
}

function hasTrailingPositionalArgvAfterInlineCommand(argv: string[]): boolean {
  const wrapperArgv = unwrapShellWrapperArgv(argv);
  const token0 = wrapperArgv[0]?.trim();
  if (!token0) {
    return false;
  }

  const wrapper = normalizeExecutableToken(token0);
  if (!POSIX_OR_POWERSHELL_INLINE_WRAPPER_NAMES.has(wrapper)) {
    return false;
  }

  const inlineCommandIndex =
    wrapper === "powershell" || wrapper === "pwsh"
      ? resolvePowerShellInlineCommandMatch(wrapperArgv).valueTokenIndex
      : wrapper === "nu"
        ? resolveNushellInlineCommandValueTokenIndex(wrapperArgv)
        : resolveInlineCommandMatch(wrapperArgv, POSIX_INLINE_COMMAND_FLAGS, {
            allowCombinedC: true,
          }).valueTokenIndex;
  if (inlineCommandIndex === null) {
    return false;
  }
  if (
    (wrapper === "powershell" || wrapper === "pwsh") &&
    isPowerShellInlineRestCommandFlag(wrapperArgv[inlineCommandIndex - 1] ?? "")
  ) {
    return false;
  }
  return wrapperArgv.slice(inlineCommandIndex + 1).some((entry) => entry.trim().length > 0);
}

function resolveNushellInlineCommandValueTokenIndex(argv: string[]): number | null {
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]?.trim() ?? "";
    if (!arg || arg === "--") {
      return null;
    }
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const flag = arg.slice(0, equalsIndex).toLowerCase();
    if (flag.startsWith("--") && NUSHELL_INLINE_COMMAND_FLAGS.has(flag)) {
      return i;
    }
  }
  return resolveInlineCommandMatch(argv, NUSHELL_INLINE_COMMAND_FLAGS, {
    allowCombinedC: true,
  }).valueTokenIndex;
}

/** Resolve request command fields while accepting the legacy shell-preview text. */
export function resolveSystemRunCommandRequest(params: {
  command?: unknown;
  rawCommand?: unknown;
}): ResolvedSystemRunCommand {
  const raw = normalizeNullableString(params.rawCommand);
  const command = Array.isArray(params.command) ? params.command : [];
  if (command.length === 0) {
    if (raw) {
      return {
        ok: false,
        message: "rawCommand requires params.command",
        details: { code: "MISSING_COMMAND" },
      };
    }
    return {
      ok: true,
      argv: [],
      commandText: "",
      shellPayload: null,
      previewText: null,
    };
  }

  const argv = command.map((v) => String(v));
  const rawlessShellWrapperResolution = extractShellWrapperCommand(argv);
  const shellWrapperResolution =
    rawlessShellWrapperResolution.command === null && raw !== null
      ? extractShellWrapperCommand(argv, raw)
      : rawlessShellWrapperResolution;
  const shellPayload = shellWrapperResolution.command;
  const shellWrapperPositionalArgv = hasTrailingPositionalArgvAfterInlineCommand(argv);
  const envManipulationBeforeShellWrapper =
    shellWrapperResolution.isWrapper && hasEnvManipulationBeforeShellWrapper(argv);
  const commandText = formatExecCommand(argv);
  const previewText =
    shellPayload !== null && !envManipulationBeforeShellWrapper && !shellWrapperPositionalArgv
      ? shellPayload.trim()
      : null;

  if (raw) {
    // rawCommand is display-only metadata. Reject mismatches so approvals cannot
    // show one command while executing a different argv.
    const matchesCanonicalArgv = raw === commandText;
    const matchesLegacyShellText = previewText !== null && raw === previewText;
    if (!matchesCanonicalArgv && !matchesLegacyShellText) {
      return {
        ok: false,
        message: "INVALID_REQUEST: rawCommand does not match command",
        details: {
          code: "RAW_COMMAND_MISMATCH",
          rawCommand: raw,
          inferred: commandText,
          formattedArgv: commandText,
        },
      };
    }
  }

  return { ok: true, argv, commandText, shellPayload, previewText };
}
