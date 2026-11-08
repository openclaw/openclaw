import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { throwExpectedCliError } from "./expected-cli-error.js";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";

const MAX_TCP_PORT = 65_535;

function parsePort(
  raw: unknown,
  flagName: string,
  fail: (message: string) => never,
): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  const parsed = parseStrictPositiveInteger(typeof raw === "bigint" ? String(raw) : raw);
  if (parsed === undefined || parsed > MAX_TCP_PORT) {
    fail(`${flagName} must be an integer between 1 and ${MAX_TCP_PORT}.`);
  }
  return parsed;
}

export function parseGatewayPortOption(raw: unknown, flagName = "--port"): number | undefined {
  return parsePort(raw, flagName, (message) => {
    throw new Error(message);
  });
}

/** Gateway client commands report a bad --port like any other CLI input error. */
export function parseGatewayClientPortOption(raw: unknown): number | undefined {
  return parsePort(raw, "--port", throwExpectedCliError);
}

export function resolveGatewayLocalPortOverride(
  opts: Pick<GatewayRpcOpts, "port" | "url"> & { localPortOverride?: number },
): number | undefined {
  const port = opts.localPortOverride ?? parseGatewayClientPortOption(opts.port);
  if (port !== undefined && typeof opts.url === "string" && opts.url.trim()) {
    throwExpectedCliError("Use either --url or --port, not both.");
  }
  return port;
}
