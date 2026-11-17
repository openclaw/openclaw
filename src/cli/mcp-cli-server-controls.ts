/** Shared `mcp add` and `mcp configure` flags applied to one saved server definition. */
import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeStringifiedOptionalString,
  readNonBlankString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeCsvOrLooseStringList } from "@openclaw/normalization-core/string-normalization";

export type McpServerControlOptions = {
  auth?: string;
  oauthScope?: string;
  oauthRedirectUrl?: string;
  oauthClientMetadataUrl?: string;
  include?: string;
  exclude?: string;
  timeout?: string;
  connectTimeout?: string;
  parallel?: boolean;
  approval?: string;
  sslVerify?: string;
  clientCert?: string;
  clientKey?: string;
  probe?: boolean;
  clearTools?: boolean;
  clearTimeouts?: boolean;
  clearAuth?: boolean;
  clearTls?: boolean;
};

export function parseCsvList(value: string | undefined): string[] | undefined {
  const entries = normalizeCsvOrLooseStringList(value);
  return entries.length > 0 ? entries : undefined;
}

export function setOptionalField(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

export function applyMcpServerControls(
  server: Record<string, unknown>,
  opts: McpServerControlOptions,
  fail: (message: string) => never,
): void {
  const include = parseCsvList(opts.include);
  const exclude = parseCsvList(opts.exclude);
  if (opts.clearTools) {
    delete server.toolFilter;
  } else if (include || exclude) {
    server.toolFilter = {
      ...asRecord(server.toolFilter),
      ...(include ? { include } : {}),
      ...(exclude ? { exclude } : {}),
    };
  }
  if (opts.clearTimeouts) {
    delete server.requestTimeoutMs;
    delete server.connectionTimeoutMs;
  }
  for (const [option, field, label] of [
    ["timeout", "requestTimeoutMs", "--timeout"],
    ["connectTimeout", "connectionTimeoutMs", "--connect-timeout"],
  ] as const) {
    const value = opts[option];
    if (value === undefined) {
      continue;
    }
    const seconds = parseStrictFiniteNumber(value);
    if (seconds === undefined || seconds <= 0) {
      fail(`${label} must be a positive number.`);
    }
    server[field] = seconds * 1_000;
  }
  if (opts.parallel === true) {
    server.supportsParallelToolCalls = true;
  } else if (opts.parallel === false) {
    delete server.supportsParallelToolCalls;
    delete server.supports_parallel_tool_calls;
  }
  const approval = opts.approval;
  if (approval !== undefined) {
    const approvalMode = normalizeLowercaseStringOrEmpty(approval);
    if (approvalMode !== "auto" && approvalMode !== "prompt" && approvalMode !== "approve") {
      fail('--approval must be "auto", "prompt", or "approve".');
    }
    server.codex = { ...asRecord(server.codex), defaultToolsApprovalMode: approvalMode };
  }
}

export function applyMcpHttpControls(
  server: Record<string, unknown>,
  opts: McpServerControlOptions,
  fail: (message: string) => never,
): void {
  if (opts.clearAuth) {
    delete server.auth;
    delete server.oauth;
  }
  const auth = normalizeLowercaseStringOrEmpty(normalizeStringifiedOptionalString(opts.auth) ?? "");
  if (auth && auth !== "oauth") {
    fail('Invalid --auth value. Use "oauth".');
  }
  if (auth) {
    server.auth = auth;
  }
  const oauth: Record<string, string> = {};
  for (const [field, input] of [
    ["scope", opts.oauthScope],
    ["redirectUrl", opts.oauthRedirectUrl],
    ["clientMetadataUrl", opts.oauthClientMetadataUrl],
  ] as const) {
    const value = input?.trim();
    if (value) {
      oauth[field] = value;
    }
  }
  if (Object.keys(oauth).length > 0) {
    server.oauth = { ...asRecord(server.oauth), ...oauth };
  }
  if (opts.clearTls) {
    for (const field of [
      "sslVerify",
      "ssl_verify",
      "clientCert",
      "client_cert",
      "clientKey",
      "client_key",
    ]) {
      delete server[field];
    }
  }
  if (opts.sslVerify !== undefined) {
    const sslVerify = normalizeLowercaseStringOrEmpty(opts.sslVerify);
    if (sslVerify !== "true" && sslVerify !== "false") {
      fail("--ssl-verify must be true or false.");
    }
    server.sslVerify = sslVerify === "true";
  }
  setOptionalField(server, "clientCert", readNonBlankString(opts.clientCert));
  setOptionalField(server, "clientKey", readNonBlankString(opts.clientKey));
}
