import { normalizeExecutableToken } from "./exec-wrapper-resolution.js";

export type InterpreterInlineEvalHit = {
  executable: string;
  normalizedExecutable: string;
  flag: string;
  argv: string[];
};

type InterpreterFlagSpec = {
  names: readonly string[];
  exactFlags: ReadonlySet<string>;
  prefixFlags?: readonly string[];
};

type PositionalInterpreterSpec = {
  names: readonly string[];
  fileFlags: ReadonlySet<string>;
  fileFlagPrefixes?: readonly string[];
  exactValueFlags: ReadonlySet<string>;
  prefixValueFlags?: readonly string[];
};

const INTERPRETER_INLINE_EVAL_SPECS: readonly InterpreterFlagSpec[] = [
  { names: ["python", "python2", "python3", "pypy", "pypy3"], exactFlags: new Set(["-c"]) },
  {
    names: ["node", "nodejs", "bun", "deno"],
    exactFlags: new Set(["-e", "--eval", "-p", "--print"]),
  },
  { names: ["ruby"], exactFlags: new Set(["-e"]) },
  { names: ["perl"], exactFlags: new Set(["-e", "-E"]) },
  { names: ["php"], exactFlags: new Set(["-r"]) },
  { names: ["lua"], exactFlags: new Set(["-e"]) },
  { names: ["osascript"], exactFlags: new Set(["-e"]) },
];

const POSITIONAL_INTERPRETER_INLINE_EVAL_SPECS: readonly PositionalInterpreterSpec[] = [
  {
    names: ["awk", "gawk", "mawk", "nawk"],
    fileFlags: new Set(["-f", "--file"]),
    fileFlagPrefixes: ["-f", "--file="],
    exactValueFlags: new Set([
      "-f",
      "--file",
      "-F",
      "--field-separator",
      "-v",
      "--assign",
      "-i",
      "--include",
      "-l",
      "--load",
      "-W",
    ]),
    prefixValueFlags: ["-F", "--field-separator=", "-v", "--assign=", "--include=", "--load="],
  },
];

const INTERPRETER_ALLOWLIST_NAMES = new Set(
  INTERPRETER_INLINE_EVAL_SPECS.flatMap((entry) => entry.names).concat(
    POSITIONAL_INTERPRETER_INLINE_EVAL_SPECS.flatMap((entry) => entry.names),
  ),
);

function findInterpreterSpec(executable: string): InterpreterFlagSpec | null {
  const normalized = normalizeExecutableToken(executable);
  for (const spec of INTERPRETER_INLINE_EVAL_SPECS) {
    if (spec.names.includes(normalized)) {
      return spec;
    }
  }
  return null;
}

function findPositionalInterpreterSpec(executable: string): PositionalInterpreterSpec | null {
  const normalized = normalizeExecutableToken(executable);
  for (const spec of POSITIONAL_INTERPRETER_INLINE_EVAL_SPECS) {
    if (spec.names.includes(normalized)) {
      return spec;
    }
  }
  return null;
}

export function detectInterpreterInlineEvalArgv(
  argv: string[] | undefined | null,
): InterpreterInlineEvalHit | null {
  if (!Array.isArray(argv) || argv.length === 0) {
    return null;
  }
  const executable = argv[0]?.trim();
  if (!executable) {
    return null;
  }
  const spec = findInterpreterSpec(executable);
  if (spec) {
    for (let idx = 1; idx < argv.length; idx += 1) {
      const token = argv[idx]?.trim();
      if (!token) {
        continue;
      }
      if (token === "--") {
        break;
      }
      const lower = token.toLowerCase();
      if (spec.exactFlags.has(lower)) {
        return {
          executable,
          normalizedExecutable: normalizeExecutableToken(executable),
          flag: lower,
          argv,
        };
      }
      if (spec.prefixFlags?.some((prefix) => lower.startsWith(prefix))) {
        return {
          executable,
          normalizedExecutable: normalizeExecutableToken(executable),
          flag: lower,
          argv,
        };
      }
    }
  }

  const positionalSpec = findPositionalInterpreterSpec(executable);
  if (!positionalSpec) {
    return null;
  }
  for (let idx = 1; idx < argv.length; idx += 1) {
    const token = argv[idx]?.trim();
    if (!token) {
      continue;
    }
    if (token === "--") {
      const nextToken = argv[idx + 1]?.trim();
      if (!nextToken) {
        return null;
      }
      return {
        executable,
        normalizedExecutable: normalizeExecutableToken(executable),
        flag: "<program>",
        argv,
      };
    }
    if (positionalSpec.fileFlags.has(token)) {
      return null;
    }
    if (
      positionalSpec.fileFlagPrefixes?.some(
        (prefix) => token.startsWith(prefix) && token.length > prefix.length,
      )
    ) {
      return null;
    }
    if (positionalSpec.exactValueFlags.has(token)) {
      idx += 1;
      continue;
    }
    if (
      positionalSpec.prefixValueFlags?.some(
        (prefix) => token.startsWith(prefix) && token.length > prefix.length,
      )
    ) {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return {
      executable,
      normalizedExecutable: normalizeExecutableToken(executable),
      flag: "<program>",
      argv,
    };
  }
  return null;
}

export function describeInterpreterInlineEval(hit: InterpreterInlineEvalHit): string {
  if (hit.flag === "<program>") {
    return `${hit.normalizedExecutable} inline program`;
  }
  return `${hit.normalizedExecutable} ${hit.flag}`;
}

export function isInterpreterLikeAllowlistPattern(pattern: string | undefined | null): boolean {
  const trimmed = pattern?.trim().toLowerCase() ?? "";
  if (!trimmed) {
    return false;
  }
  const normalized = normalizeExecutableToken(trimmed);
  if (INTERPRETER_ALLOWLIST_NAMES.has(normalized)) {
    return true;
  }
  const basename = trimmed.replace(/\\/g, "/").split("/").pop() ?? trimmed;
  const withoutExe = basename.endsWith(".exe") ? basename.slice(0, -4) : basename;
  const strippedWildcards = withoutExe.replace(/[*?[\]{}()]/g, "");
  return INTERPRETER_ALLOWLIST_NAMES.has(strippedWildcards);
}
