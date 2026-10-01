import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readSecretFromFile } from "../acp/secret-file.js";
import { defaultRuntime } from "../runtime.js";

function resolveGatewaySecretOption(
  directValue: unknown,
  fileValue: unknown,
  kind: "token" | "password",
): string | undefined {
  const direct = normalizeOptionalString(directValue);
  const file = normalizeOptionalString(fileValue);
  if (direct && file) {
    throw new Error(`Use either --${kind} or --${kind}-file for Gateway ${kind}.`);
  }
  return file ? readSecretFromFile(file, `Gateway ${kind}`) : direct;
}

function warnGatewaySecretCliFlag(flag: "--token" | "--password"): void {
  defaultRuntime.error(
    `Warning: ${flag} can be exposed via process listings. Prefer ${flag}-file or environment variables.`,
  );
}

export function resolveGatewayAuthOptions(opts: {
  token?: unknown;
  tokenFile?: unknown;
  password?: unknown;
  passwordFile?: unknown;
}): {
  gatewayToken?: string;
  gatewayPassword?: string;
} {
  const gatewayToken = resolveGatewaySecretOption(opts.token, opts.tokenFile, "token");
  const gatewayPassword = resolveGatewaySecretOption(opts.password, opts.passwordFile, "password");
  if (opts.token) {
    warnGatewaySecretCliFlag("--token");
  }
  if (opts.password) {
    warnGatewaySecretCliFlag("--password");
  }
  return { gatewayToken, gatewayPassword };
}
