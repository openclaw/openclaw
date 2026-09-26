// Parses strict TCP port inputs for config and CLI surfaces.
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";

// TCP port parsing is strict because config and CLI inputs both use this helper.
export const MAX_TCP_PORT = 65_535;

/** Parse a positive TCP port or return null for absent/invalid input. */
export function parseTcpPort(raw: unknown): number | null {
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed === undefined || parsed > MAX_TCP_PORT) {
    return null;
  }
  return parsed;
}

/** Extract the effective `--port` value from command arguments. */
export function parseTcpPortFromArgs(programArguments: string[] | undefined): number | null {
  if (!programArguments?.length) {
    return null;
  }
  let latestPort: number | null = null;
  for (let index = 0; index < programArguments.length; index += 1) {
    const argument = programArguments[index];
    let value: string | undefined;
    if (argument === "--port") {
      value = programArguments[++index];
    } else if (argument?.startsWith("--port=")) {
      value = argument.slice("--port=".length);
    }
    latestPort = parseTcpPort(value) ?? latestPort;
  }
  return latestPort;
}
