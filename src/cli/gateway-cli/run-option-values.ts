import { asOptionalObjectRecord } from "@openclaw/normalization-core";
import type { GatewayRunOpts } from "./run-options.js";

export const toOptionString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
};

export async function resolveGatewayPasswordOption(
  opts: GatewayRunOpts,
): Promise<string | undefined> {
  const direct = toOptionString(opts.password);
  const file = toOptionString(opts.passwordFile);
  if (direct && file) {
    throw new Error("Use either --password or --password-file.");
  }
  if (file) {
    const { readSecretFromFile } = await import("../../acp/secret-file.js");
    return readSecretFromFile(file, "Gateway password");
  }
  return direct;
}

export function extractGatewayMiskeys(parsed: unknown): {
  hasGatewayToken: boolean;
  hasRemoteToken: boolean;
} {
  // Detect common token misplacements before startup falls back to unauthenticated mode.
  const gateway = asOptionalObjectRecord(asOptionalObjectRecord(parsed)?.gateway);
  const remote = asOptionalObjectRecord(gateway?.remote);
  return {
    hasGatewayToken: gateway ? "token" in gateway : false,
    hasRemoteToken: remote ? "token" in remote : false,
  };
}

export function parseEnumOption<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): T | null {
  return raw ? (allowed.find((value) => value === raw) ?? null) : null;
}
