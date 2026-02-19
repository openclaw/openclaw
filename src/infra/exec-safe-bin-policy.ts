function isPathLikeToken(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === "-") {
    return false;
  }
  if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~")) {
    return true;
  }
  if (trimmed.startsWith("/")) {
    return true;
  }
  return /^[A-Za-z]:[\\/]/.test(trimmed);
}

function hasGlobToken(value: string): boolean {
  // Safe bins are stdin-only; globbing is both surprising and a historical bypass vector.
  // Note: we still harden execution-time expansion separately.
  return /[*?[\]]/.test(value);
}

export type SafeBinProfile = {
  minPositional?: number;
  maxPositional?: number;
  valueFlags?: ReadonlySet<string>;
  blockedFlags?: ReadonlySet<string>;
};

const NO_FLAGS = new Set<string>();

export const SAFE_BIN_GENERIC_PROFILE: SafeBinProfile = {};

export const SAFE_BIN_PROFILES: Record<string, SafeBinProfile> = {
  jq: {
    maxPositional: 1,
    valueFlags: new Set([
      "--arg",
      "--argjson",
      "--argstr",
      "--argfile",
      "--rawfile",
      "--slurpfile",
      "--from-file",
      "--library-path",
      "-L",
      "-f",
    ]),
    blockedFlags: new Set([
      "--argfile",
      "--rawfile",
      "--slurpfile",
      "--from-file",
      "--library-path",
      "-L",
      "-f",
    ]),
  },
  grep: {
    maxPositional: 1,
    valueFlags: new Set([
      "--regexp",
      "--file",
      "--max-count",
      "--after-context",
      "--before-context",
      "--context",
      "--devices",
      "--directories",
      "--binary-files",
      "--exclude",
      "--exclude-from",
      "--include",
      "--label",
      "-e",
      "-f",
      "-m",
      "-A",
      "-B",
      "-C",
      "-D",
      "-d",
    ]),
    blockedFlags: new Set([
      "--file",
      "--exclude-from",
      "--dereference-recursive",
      "--directories",
      "--recursive",
      "-f",
      "-d",
      "-r",
      "-R",
    ]),
  },
  cut: {
    maxPositional: 0,
    valueFlags: new Set([
      "--bytes",
      "--characters",
      "--fields",
      "--delimiter",
      "--output-delimiter",
      "-b",
      "-c",
      "-f",
      "-d",
    ]),
  },
  sort: {
    maxPositional: 0,
    valueFlags: new Set([
      "--key",
      "--field-separator",
      "--buffer-size",
      "--temporary-directory",
      "--compress-program",
      "--parallel",
      "--batch-size",
      "--random-source",
      "--files0-from",
      "--output",
      "-k",
      "-t",
      "-S",
      "-T",
      "-o",
    ]),
    blockedFlags: new Set(["--files0-from", "--output", "-o"]),
  },
  uniq: {
    maxPositional: 0,
    valueFlags: new Set([
      "--skip-fields",
      "--skip-chars",
      "--check-chars",
      "--group",
      "-f",
      "-s",
      "-w",
    ]),
  },
  head: {
    maxPositional: 0,
    valueFlags: new Set(["--lines", "--bytes", "-n", "-c"]),
  },
  tail: {
    maxPositional: 0,
    valueFlags: new Set([
      "--lines",
      "--bytes",
      "--sleep-interval",
      "--max-unchanged-stats",
      "--pid",
      "-n",
      "-c",
    ]),
  },
  tr: {
    minPositional: 1,
    maxPositional: 2,
  },
  wc: {
    maxPositional: 0,
    valueFlags: new Set(["--files0-from"]),
    blockedFlags: new Set(["--files0-from"]),
  },
};

function isSafeLiteralToken(value: string): boolean {
  if (!value || value === "-") {
    return true;
  }
  return !hasGlobToken(value) && !isPathLikeToken(value);
}

export function validateSafeBinArgv(args: string[], profile: SafeBinProfile): boolean {
  const valueFlags = profile.valueFlags ?? NO_FLAGS;
  const blockedFlags = profile.blockedFlags ?? NO_FLAGS;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token) {
      continue;
    }
    if (token === "--") {
      for (let j = i + 1; j < args.length; j += 1) {
        const rest = args[j];
        if (!rest || rest === "-") {
          continue;
        }
        if (!isSafeLiteralToken(rest)) {
          return false;
        }
        positional.push(rest);
      }
      break;
    }
    if (token === "-") {
      continue;
    }
    if (!token.startsWith("-")) {
      if (!isSafeLiteralToken(token)) {
        return false;
      }
      positional.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      const flag = eqIndex > 0 ? token.slice(0, eqIndex) : token;
      if (blockedFlags.has(flag)) {
        return false;
      }
      if (eqIndex > 0) {
        if (!isSafeLiteralToken(token.slice(eqIndex + 1))) {
          return false;
        }
        continue;
      }
      if (!valueFlags.has(flag)) {
        continue;
      }
      const value = args[i + 1];
      if (!value || !isSafeLiteralToken(value)) {
        return false;
      }
      i += 1;
      continue;
    }

    let consumedValue = false;
    for (let j = 1; j < token.length; j += 1) {
      const flag = `-${token[j]}`;
      if (blockedFlags.has(flag)) {
        return false;
      }
      if (!valueFlags.has(flag)) {
        continue;
      }
      const inlineValue = token.slice(j + 1);
      if (inlineValue) {
        if (!isSafeLiteralToken(inlineValue)) {
          return false;
        }
      } else {
        const value = args[i + 1];
        if (!value || !isSafeLiteralToken(value)) {
          return false;
        }
        i += 1;
      }
      consumedValue = true;
      break;
    }
    if (!consumedValue && hasGlobToken(token)) {
      return false;
    }
  }

  const minPositional = profile.minPositional ?? 0;
  if (positional.length < minPositional) {
    return false;
  }
  if (typeof profile.maxPositional === "number" && positional.length > profile.maxPositional) {
    return false;
  }
  return true;
}
