import { consumeRootOptionToken, FLAG_TERMINATOR } from "../infra/cli-root-options.js";

type CliRootOptionScanResult = { ok: true; argv: string[] } | { ok: false; error: string };

type CliRootOptionVisitResult =
  | { kind: "pass" }
  | { kind: "handled"; consumedNext?: boolean }
  | { kind: "error"; error: string };

export function scanCliRootOptions(
  argv: string[],
  visit: (params: {
    arg: string;
    args: string[];
    index: number;
    out: string[];
  }) => CliRootOptionVisitResult,
): CliRootOptionScanResult {
  if (argv.length < 2) {
    return { ok: true, argv };
  }

  const out: string[] = argv.slice(0, 2);
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === FLAG_TERMINATOR) {
      // `--` ends root-option handling; everything after it belongs to the target command.
      out.push(arg, ...args.slice(i + 1));
      break;
    }

    const visited = visit({ arg, args, index: i, out });
    if (visited.kind === "error") {
      return { ok: false, error: visited.error };
    }
    if (visited.kind === "handled") {
      if (visited.consumedNext) {
        i += 1;
      }
      continue;
    }

    const consumedRootOption = consumeRootOptionToken(args, i);
    if (consumedRootOption > 0) {
      out.push(...args.slice(i, i + consumedRootOption));
      i += consumedRootOption - 1;
      continue;
    }

    out.push(arg);
  }

  return { ok: true, argv: out };
}
